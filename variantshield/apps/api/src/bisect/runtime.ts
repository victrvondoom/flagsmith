import { EventEmitter } from "node:events";
import type { Ctx } from "../context.ts";
import { HttpError } from "../http.ts";
import { appendEntry, record } from "../ledger.ts";
import {
  conclude, designProbe, detectOnset, involvement, judge, priors, sampleRatioMismatch, update,
  type Belief, type Bucket, type Judgement, type PriorExplanation, type Suspect,
} from "../../../../packages/bisect/src/index.ts";
import { SIM_SCENARIOS, SimulatedWorld, sameValue, type AppliedProbe, type CanaryHandle, type FlagControl, type Flags, type Signal } from "./control.ts";

/**
 * The incident swarm. Seven deterministic agents share one blackboard (the `incidents`, `probes` and `swarm_messages`
 * tables). Each tick, every agent looks at the incident's state and either acts or waits. No model is involved; each
 * agent is a small, testable rule set with one job.
 *
 * Where the swarm stops for a person:
 *  1. Before any change to Flagsmith: a person approves the envelope (which changes may be reverted, for how big a
 *     canary, for how many rounds and minutes). Inside it, the swarm probes on its own.
 *  2. Before anything reaches everyone: a remediation is proposed by one person and approved by a different person.
 */

export type Source = "real" | "simulation";
export type IncidentState =
  | "INVESTIGATING" | "AWAITING_APPROVAL" | "PROBING" | "CONFIRMING"
  | "IDENTIFIED" | "NOT_A_FLAG_CHANGE" | "INCONCLUSIVE" | "ABORTED"
  | "REMEDIATION_PROPOSED" | "REMEDIATED" | "RESOLVED";
const TERMINAL: IncidentState[] = ["NOT_A_FLAG_CHANGE", "INCONCLUSIVE", "ABORTED", "RESOLVED"];

export const AGENTS = [
  { id: "sentinel", name: "Sentinel", role: "Watches the failure rate and dates the onset of a regression (Bernoulli CUSUM)." },
  { id: "archivist", name: "Archivist", role: "Collects every flag change in the window before the onset from Flagsmith." },
  { id: "profiler", name: "Profiler", role: "Turns evidence (recency, blast radius, timing) into prior odds for each change." },
  { id: "guardian", name: "Guardian", role: "Proposes and holds the approved envelope; vetoes probes outside it and aborts on harm." },
  { id: "prober", name: "Prober", role: "Chooses which changes to revert for the canary next (Bayesian bisection) and applies it." },
  { id: "judge", name: "Judge", role: "Decides each probe with an always-valid sequential test (mSPRT) and updates the odds." },
  { id: "scribe", name: "Scribe", role: "Records every step in the decision ledger and drafts the remediation for people to approve." },
] as const;
export type AgentId = (typeof AGENTS)[number]["id"];

export interface Envelope { suspects: string[]; canaryPercent: number; maxRounds: number; maxRevert: number; maxMinutes: number }
interface ActiveProbe { id: number; round: number; kind: "bisect" | "confirm"; revert: string[]; startedAt: number; applied: AppliedProbe }
interface IncidentData {
  scenario?: string;
  suspects: Suspect[];
  priorExplanation: PriorExplanation[];
  beliefs: Belief[];
  envelope: Envelope | null;
  envelopeApproval: { actor: string; at: number; seq: number; reason: string } | null;
  canary: CanaryHandle | null;
  probe: ActiveProbe | null;
  rounds: number;
  conclusion: { status: string; key: string; confidence: number; ids: string[] } | null;
  confirmed: boolean;
  remediation: { draftedAt: number; restore: { feature: string; to: Suspect["before"] }[]; proposedBy: string | null; proposedSeq: number | null; approvedBy: string | null; result: unknown } | null;
  regressionRate: number;
  lastJudgement: Judgement | null;
  waitingOn: string | null;
}

export interface SwarmEvent { type: "incident" | "message" | "tick"; incidentId: number | null; source: Source; data: unknown }

const SETTLE = { simulation: 20_000, real: 30_000 } as const; // ignore traffic right after a segment change (SDK refresh)
const PROBE_TIMEOUT = { simulation: 6 * 60_000, real: 12 * 60_000 } as const;
const BUCKET_MS = 60_000;

export class BisectRuntime {
  readonly bus = new EventEmitter();
  sim: SimulatedWorld | null = null;
  private simIncidentScenario: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly ctx: Ctx;
  readonly real: FlagControl | null;

  constructor(ctx: Ctx, real: FlagControl | null) {
    this.ctx = ctx;
    this.real = real;
    this.bus.setMaxListeners(100);
  }

  /* ------------------------------------------------------------------------------------- clock & control */

  clock(source: Source): number { return source === "simulation" ? (this.sim?.clock ?? this.ctx.now()) : this.ctx.now(); }
  control(source: Source): FlagControl {
    if (source === "simulation") { if (!this.sim) throw new HttpError(409, "no_simulation", "No simulation is running. Start one first."); return this.sim; }
    if (!this.real) throw new HttpError(503, "flagsmith_not_configured", "Set FLAGSMITH_URL, FLAGSMITH_ENVIRONMENT_KEY and a Management API credential to bisect real incidents.");
    return this.real;
  }

  start(intervalMs = 250): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Starts a deterministic simulated incident (SIMULATION, no Flagsmith). Ends any earlier simulated incident. */
  startSimulation(scenarioId: string, seed = 7): { scenario: string; startedAt: number } {
    const sc = SIM_SCENARIOS.find((s) => s.id === scenarioId);
    if (!sc) throw new HttpError(404, "scenario_not_found", `Unknown scenario; use one of ${SIM_SCENARIOS.map((s) => s.id).join(", ")}`);
    for (const r of this.ctx.db.all("SELECT id FROM incidents WHERE source = 'simulation' AND state NOT IN ('NOT_A_FLAG_CHANGE','INCONCLUSIVE','ABORTED','RESOLVED')")) {
      this.setState(Number(r.id), "ABORTED", "Replaced by a new simulation");
    }
    this.ctx.db.run("DELETE FROM bisect_signals WHERE source = 'simulation'");
    const start = this.ctx.now() - 11 * 60_000;
    this.sim = new SimulatedWorld(sc, start, seed);
    this.simIncidentScenario = sc.id;
    // Ten simulated minutes of healthy history so the Sentinel has a baseline.
    this.storeSignals("simulation", this.sim.traffic(10 * 60_000, 9000));
    this.emit({ type: "tick", incidentId: null, source: "simulation", data: { clock: this.sim.clock, scenario: sc.id } });
    return { scenario: sc.id, startedAt: start };
  }

  /* ------------------------------------------------------------------------------------- signals */

  storeSignals(source: Source, signals: Signal[]): number {
    if (!signals.length) return 0;
    this.ctx.db.tx(() => {
      for (const s of signals) this.ctx.db.run("INSERT INTO bisect_signals (ts, identity, ok, flags, source) VALUES (?,?,?,?,?)", s.ts, s.identity, s.ok ? 1 : 0, JSON.stringify(s.flags), source);
    });
    return signals.length;
  }

  private buckets(source: Source, sinceMs: number, untilMs: number): Bucket[] {
    // Integer literal on purpose: node:sqlite binds JS numbers as REAL, and ts / 60000.0 would not bucket.
    const rows = this.ctx.db.all(`SELECT ts / ${BUCKET_MS} AS b, COUNT(*) AS n, SUM(1 - ok) AS f FROM bisect_signals WHERE source = ? AND ts >= ? AND ts < ? GROUP BY b ORDER BY b`, source, sinceMs, untilMs);
    return rows.map((r) => ({ start: Number(r.b) * BUCKET_MS, n: Number(r.n), failures: Number(r.f) }));
  }

  /* ------------------------------------------------------------------------------------- blackboard */

  private emit(e: SwarmEvent): void { this.bus.emit("event", e); }

  say(incidentId: number, agent: AgentId | "human", kind: string, text: string, data: unknown = {}): void {
    const source = this.sourceOf(incidentId);
    const ts = this.clock(source);
    const id = this.ctx.db.run("INSERT INTO swarm_messages (incident_id, ts, agent, kind, text, data) VALUES (?,?,?,?,?,?)", incidentId, ts, agent, kind, text, JSON.stringify(data)).lastInsertRowid;
    this.emit({ type: "message", incidentId, source, data: { id, ts, agent, kind, text, data } });
  }

  private sourceOf(id: number): Source { return (this.ctx.db.get("SELECT source FROM incidents WHERE id = ?", id)?.source as Source | undefined) ?? "real"; }

  load(id: number): { id: number; source: Source; state: IncidentState; openedAt: number; onsetAt: number | null; baselineRate: number; data: IncidentData } {
    const r = this.ctx.db.get("SELECT * FROM incidents WHERE id = ?", id);
    if (!r) throw new HttpError(404, "incident_not_found", "No such incident");
    return { id, source: r.source as Source, state: r.state as IncidentState, openedAt: Number(r.opened_at), onsetAt: r.onset_at === null ? null : Number(r.onset_at), baselineRate: Number(r.baseline_rate ?? 0), data: JSON.parse(String(r.data)) as IncidentData };
  }

  private save(id: number, data: IncidentData, state?: IncidentState): void {
    if (state) this.ctx.db.run("UPDATE incidents SET data = ?, state = ?, updated_at = ? WHERE id = ?", JSON.stringify(data), state, this.ctx.now(), id);
    else this.ctx.db.run("UPDATE incidents SET data = ?, updated_at = ? WHERE id = ?", JSON.stringify(data), this.ctx.now(), id);
    this.emit({ type: "incident", incidentId: id, source: this.sourceOf(id), data: { state: state ?? null } });
  }

  private setState(id: number, state: IncidentState, why: string): void {
    const inc = this.load(id);
    this.save(id, inc.data, state);
    this.say(id, "scribe", "state", `${inc.state} → ${state}: ${why}`, { from: inc.state, to: state });
  }

  /* ------------------------------------------------------------------------------------- the tick */

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.sim) {
        this.storeSignals("simulation", this.sim.traffic(20_000, 900));
        this.emit({ type: "tick", incidentId: null, source: "simulation", data: { clock: this.sim.clock } });
      }
      for (const source of ["simulation", "real"] as const) {
        if (source === "simulation" && !this.sim) continue;
        if (source === "real" && !this.real) continue;
        await this.sentinel(source);
      }
      const open = this.ctx.db.all("SELECT id FROM incidents WHERE state NOT IN ('NOT_A_FLAG_CHANGE','INCONCLUSIVE','ABORTED','RESOLVED') ORDER BY id");
      for (const r of open) {
        const id = Number(r.id);
        if (this.sourceOf(id) === "simulation" && !this.sim) continue;
        try { await this.step(id); } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.say(id, "guardian", "error", `Stopped: ${msg}`);
          await this.safeTeardown(id);
          this.setState(id, "ABORTED", `an action failed (${msg}); canary removed where possible`);
        }
      }
    } finally { this.busy = false; }
  }

  /** Sentinel: open an incident when the failure rate shifts (and nothing is open for this source). Also confirms recovery. */
  private async sentinel(source: Source): Promise<void> {
    const now = this.clock(source);
    const open = this.ctx.db.get("SELECT id, state FROM incidents WHERE source = ? AND state NOT IN ('NOT_A_FLAG_CHANGE','INCONCLUSIVE','ABORTED','RESOLVED') ORDER BY id DESC LIMIT 1", source);
    if (open) {
      if (open.state !== "REMEDIATED") return;
      const inc = this.load(Number(open.id));
      const recent = this.buckets(source, now - 3 * BUCKET_MS, now);
      const n = recent.reduce((a, b) => a + b.n, 0), f = recent.reduce((a, b) => a + b.failures, 0);
      if (n >= 300 && f / n <= inc.baselineRate + (inc.data.regressionRate - inc.baselineRate) / 3) {
        this.say(inc.id, "sentinel", "recovered", `Failure rate is back to ${(100 * f / n).toFixed(2)}% over the last 3 minutes (baseline ${(100 * inc.baselineRate).toFixed(2)}%).`);
        record(this.ctx, { kind: "incident.resolved", subjectType: "incident", subjectId: String(inc.id), actor: "swarm:sentinel", source, summary: `Incident #${inc.id} resolved: failure rate back to ${(100 * f / n).toFixed(2)}%` });
        this.setState(inc.id, "RESOLVED", "the regression is gone");
      }
      return;
    }
    // Do not re-open on the tail of an incident that just closed.
    const last = this.ctx.db.get("SELECT updated_at FROM incidents WHERE source = ? ORDER BY id DESC LIMIT 1", source);
    const since = Math.max(now - 45 * BUCKET_MS, source === "real" && last ? Number(last.updated_at) : 0);
    const buckets = this.buckets(source, since, Math.floor(now / BUCKET_MS) * BUCKET_MS);
    if (buckets.length < 8 || (source === "simulation" && this.simIncidentScenario === null)) return;
    const o = detectOnset(buckets);
    if (!o.alarmed || o.onsetAt === null) return;
    if (source === "simulation") this.simIncidentScenario = null; // one incident per simulation run
    const after = buckets.filter((b) => b.start >= o.onsetAt!);
    const an = after.reduce((a, b) => a + b.n, 0), af = after.reduce((a, b) => a + b.failures, 0);
    const data: IncidentData = { scenario: this.sim?.scenario.id, suspects: [], priorExplanation: [], beliefs: [], envelope: null, envelopeApproval: null, canary: null, probe: null, rounds: 0, conclusion: null, confirmed: false, remediation: null, regressionRate: an ? af / an : o.currentRate, lastJudgement: null, waitingOn: null };
    const id = this.ctx.db.run("INSERT INTO incidents (source, state, opened_at, updated_at, onset_at, baseline_rate, data) VALUES (?,?,?,?,?,?,?)", source, "INVESTIGATING", now, this.ctx.now(), o.onsetAt, o.baselineRate, JSON.stringify(data)).lastInsertRowid;
    this.say(id, "sentinel", "opened", `Failure rate rose from ${(o.baselineRate * 100).toFixed(2)}% to ${(data.regressionRate * 100).toFixed(2)}%. Onset estimated at ${iso(o.onsetAt)} (CUSUM alarm at ${iso(o.alarmAt!)}).`, { onsetAt: o.onsetAt, alarmAt: o.alarmAt, baselineRate: o.baselineRate, regressionRate: data.regressionRate });
    record(this.ctx, { kind: "incident.opened", subjectType: "incident", subjectId: String(id), actor: "swarm:sentinel", source, summary: `Incident #${id}: failure rate ${(o.baselineRate * 100).toFixed(2)}% → ${(data.regressionRate * 100).toFixed(2)}%, onset ${iso(o.onsetAt)}`, payload: { onsetAt: o.onsetAt, baselineRate: o.baselineRate, regressionRate: data.regressionRate } });
    this.emit({ type: "incident", incidentId: id, source, data: { state: "INVESTIGATING" } });
  }

  private async step(id: number): Promise<void> {
    const inc = this.load(id);
    const d = inc.data;
    const ctl = this.control(inc.source);
    const now = this.clock(inc.source);
    switch (inc.state) {
      case "INVESTIGATING": {
        // Archivist
        const suspects = await ctl.recentChanges(inc.onsetAt! - 2 * 3_600_000, now);
        this.say(id, "archivist", "suspects", suspects.length ? `Found ${suspects.length} flag change(s) in the 2 hours before the onset and since: ${suspects.map((s) => s.feature).join(", ")}.` : "No flag changes in the 2 hours before the onset.", { suspects: suspects.map((s) => ({ id: s.id, feature: s.feature, changedAt: s.changedAt, changedBy: s.changedBy })) });
        if (!suspects.length) { this.save(id, d, "NOT_A_FLAG_CHANGE"); this.say(id, "scribe", "state", "INVESTIGATING → NOT_A_FLAG_CHANGE: nothing to bisect"); return; }
        // Profiler
        const p = priors(suspects, inc.onsetAt!);
        d.suspects = suspects; d.beliefs = p.beliefs; d.priorExplanation = p.explanation;
        const top = [...p.explanation].sort((a, b) => b.weight - a.weight).slice(0, 3);
        this.say(id, "profiler", "priors", `Prior odds favour ${top.map((t) => `${feat(d, t.id)} (${pctOf(p.beliefs, t.id)})`).join(", ")}; ${p.explanation.filter((e) => e.factors.afterOnset).length} change(s) came after the onset and weigh little. Pairs that only break together carry ${pctOf(p.beliefs, "pairs")} and "none of these" ${pctOf(p.beliefs, "none")}.`, { explanation: p.explanation });
        // Guardian proposes the envelope
        const canaryPercent = inc.source === "simulation" ? 10 : 5;
        d.envelope = { suspects: suspects.map((s) => s.id), canaryPercent, maxRounds: 10, maxRevert: suspects.length, maxMinutes: inc.source === "simulation" ? 60 : 45 };
        d.waitingOn = `a person to approve the envelope (type "BISECT ${id}")`;
        this.say(id, "guardian", "envelope", `Proposed envelope: revert any of ${suspects.length} change(s), for ${canaryPercent}% of traffic only, at most ${d.envelope.maxRounds} rounds and ${d.envelope.maxMinutes} minutes. Nothing changes in Flagsmith until a person approves.`, d.envelope);
        this.save(id, d, "AWAITING_APPROVAL");
        return;
      }
      case "AWAITING_APPROVAL":
      case "IDENTIFIED":
      case "REMEDIATION_PROPOSED":
        return; // waiting for people
      case "REMEDIATED":
        return; // the Sentinel confirms recovery
      case "PROBING":
      case "CONFIRMING":
        await this.probeStep(id, inc.source, inc.baselineRate, d, ctl, now, inc.state);
        return;
      default:
        return;
    }
  }

  private async probeStep(id: number, source: Source, baselineRate: number, d: IncidentData, ctl: FlagControl, now: number, state: IncidentState): Promise<void> {
    const env = d.envelope!;
    const approvedAt = d.envelopeApproval!.at;
    // Guardian: time and round limits.
    if (!d.probe && (d.rounds >= env.maxRounds || now - approvedAt > env.maxMinutes * 60_000)) {
      await this.safeTeardown(id);
      const fresh = this.load(id).data;
      this.say(id, "guardian", "limit", `Envelope exhausted after ${fresh.rounds} round(s). Canary removed. Best explanation so far: ${describeTop(fresh)}.`);
      this.save(id, fresh, "INCONCLUSIVE");
      record(this.ctx, { kind: "bisect.concluded", subjectType: "incident", subjectId: String(id), actor: "swarm:scribe", source, summary: `Incident #${id}: inconclusive within the envelope (${fresh.rounds} rounds)` });
      return;
    }
    if (!d.probe) {
      let revert: string[], kind: ActiveProbe["kind"] = "bisect", gain = 0;
      const c = conclude(d.beliefs);
      if (state === "CONFIRMING" && d.conclusion) { revert = d.conclusion.ids; kind = "confirm"; }
      else {
        const design = designProbe(d.beliefs, d.suspects, { maxRevert: env.maxRevert, exclude: new Set(d.suspects.map((s) => s.id).filter((x) => !env.suspects.includes(x))) });
        if (!design) { this.say(id, "prober", "stuck", `No probe would add information. Top explanation: ${describeTop(d)} (${(c.confidence * 100).toFixed(1)}%).`); d.rounds = env.maxRounds; this.save(id, d); return; }
        revert = design.revert; gain = design.expectedGainBits;
      }
      // Guardian: every probe must be inside the envelope.
      const outside = revert.filter((x) => !env.suspects.includes(x));
      if (outside.length || revert.length > env.maxRevert) { this.say(id, "guardian", "veto", `Vetoed a probe outside the envelope (${outside.join(", ") || `${revert.length} > ${env.maxRevert} changes`}).`); d.rounds = env.maxRounds; this.save(id, d); return; }
      if (!d.canary) { d.canary = await ctl.prepareCanary(env.canaryPercent, id); this.say(id, "prober", "canary", `Canary ready: ${d.canary.label}.`, d.canary); }
      const suspects = d.suspects.filter((s) => revert.includes(s.id));
      const applied = await ctl.applyProbe(d.canary, suspects);
      d.rounds += 1;
      const pid = this.ctx.db.run("INSERT INTO probes (incident_id, round, revert, started_at, beliefs_before) VALUES (?,?,?,?,?)", id, d.rounds, JSON.stringify(revert), now, JSON.stringify(d.beliefs)).lastInsertRowid;
      d.probe = { id: pid, round: d.rounds, kind, revert, startedAt: now, applied };
      this.say(id, "prober", kind === "confirm" ? "confirm" : "probe", kind === "confirm"
        ? `Round ${d.rounds} (confirmation): reverting exactly ${suspects.map((s) => s.feature).join(" + ")} for the canary. If it heals, that is the culprit.`
        : `Round ${d.rounds}: reverting ${suspects.map((s) => s.feature).join(", ")} for the ${env.canaryPercent}% canary only (expected gain ${gain.toFixed(2)} bits; ${(100 * (healMassOf(d.beliefs, revert))).toFixed(0)}% of the odds would heal).`, { probeId: pid, revert, kind });
      record(this.ctx, { kind: "bisect.probe", subjectType: "incident", subjectId: String(id), actor: "swarm:prober", source, summary: `Incident #${id} round ${d.rounds}: canary reverts ${suspects.map((s) => s.feature).join(", ")}`, payload: { revert, kind, canaryPercent: env.canaryPercent, overrides: applied.overrides } });
      this.save(id, d);
      return;
    }
    // Judge: compare canary and main traffic since the probe settled.
    const p = d.probe;
    const from = p.startedAt + SETTLE[source];
    if (now < from) return;
    const { canary, main, other } = this.cohorts(source, d, p.revert, from, now);
    const j = judge(canary, main, baselineRate);
    d.lastJudgement = j;
    const srm = sampleRatioMismatch(canary.n, canary.n + main.n + other, env.canaryPercent / 100);
    const timedOut = now - p.startedAt > PROBE_TIMEOUT[source];
    if (j.verdict === "inconclusive" && !timedOut) { this.save(id, d); return; }
    if (j.verdict === "harmful") {
      await this.safeTeardown(id);
      const fresh = this.load(id).data;
      this.say(id, "guardian", "abort", `Aborted: the canary got worse (${j.reason}). Canary removed; nothing else was changed.`, j);
      this.finishProbe(p.id, "harmful", j, fresh.beliefs, now);
      fresh.probe = null;
      this.save(id, fresh, "ABORTED");
      record(this.ctx, { kind: "bisect.aborted", subjectType: "incident", subjectId: String(id), actor: "swarm:guardian", source, summary: `Incident #${id}: aborted, canary was harmed`, payload: { judgement: j } });
      return;
    }
    const verdict = j.verdict === "inconclusive" ? "inconclusive" : j.verdict;
    d.beliefs = update(d.beliefs, p.revert, verdict);
    await ctl.clearProbe(d.canary!, p.applied);
    this.finishProbe(p.id, verdict, j, d.beliefs, now);
    d.probe = null;
    this.say(id, "judge", "verdict", `Round ${p.round}: ${verdict.toUpperCase().replace("_", " ")}. ${j.reason}.${srm.mismatch ? ` Warning: canary share ${(100 * canary.n / Math.max(1, canary.n + main.n + other)).toFixed(1)}% does not match ${env.canaryPercent}% (sample-ratio mismatch).` : ""}`, { verdict, judgement: j, canary, main, srm });
    if (p.kind === "confirm") {
      if (verdict === "healed") {
        d.confirmed = true;
        await this.safeTeardownData(d, ctl);
        this.draftRemediation(id, d, source);
        this.save(id, d, "IDENTIFIED");
        return;
      }
      this.say(id, "judge", "unconfirmed", "The confirmation did not heal the canary; back to bisection with the updated odds.");
      d.conclusion = null;
      this.save(id, d, "PROBING");
      return;
    }
    const c = conclude(d.beliefs);
    if (c.status === "identified") {
      d.conclusion = { status: c.status, key: c.top.key, confidence: c.confidence, ids: c.top.hypothesis.kind === "none" ? [] : [...c.top.hypothesis.ids] };
      this.say(id, "judge", "candidate", `${describeKey(d, c.top.key)} explains the regression with ${(c.confidence * 100).toFixed(1)}% probability. Confirming before anyone acts on it.`);
      this.save(id, d, "CONFIRMING");
      return;
    }
    if (c.status === "not_a_flag_change") {
      await this.safeTeardownData(d, ctl);
      d.conclusion = { status: c.status, key: "none", confidence: c.confidence, ids: [] };
      this.say(id, "scribe", "conclusion", `With ${(c.confidence * 100).toFixed(1)}% probability, none of these flag changes caused the regression: reverting them did not help the canary. Look elsewhere (deploys, dependencies, infrastructure). Canary removed.`);
      record(this.ctx, { kind: "bisect.concluded", subjectType: "incident", subjectId: String(id), actor: "swarm:scribe", source, summary: `Incident #${id}: not caused by these flag changes (${(c.confidence * 100).toFixed(1)}%)`, payload: { beliefs: d.beliefs } });
      this.save(id, d, "NOT_A_FLAG_CHANGE");
      return;
    }
    this.save(id, d);
  }

  private draftRemediation(id: number, d: IncidentData, source: Source): void {
    const culprits = d.suspects.filter((s) => d.conclusion!.ids.includes(s.id));
    d.remediation = { draftedAt: this.clock(source), restore: culprits.map((s) => ({ feature: s.feature, to: s.before })), proposedBy: null, proposedSeq: null, approvedBy: null, result: null };
    d.waitingOn = "a person to propose the remediation, and a second person to approve it";
    this.say(id, "scribe", "draft", `Confirmed: ${culprits.map((s) => s.feature).join(" + ")}. Draft remediation: restore ${culprits.map((s) => `${s.feature} to ${fmtValue(s.before)}`).join(" and ")} for everyone. One person proposes it, a different person approves it.`, d.remediation);
    record(this.ctx, { kind: "bisect.concluded", subjectType: "incident", subjectId: String(id), actor: "swarm:scribe", source, summary: `Incident #${id}: culprit ${culprits.map((s) => s.feature).join(" + ")} (${(d.conclusion!.confidence * 100).toFixed(1)}%, confirmed by a canary revert)`, payload: { culprit: culprits.map((s) => s.id), confidence: d.conclusion!.confidence, rounds: d.rounds } });
  }

  private finishProbe(pid: number, verdict: string, j: Judgement, beliefs: Belief[], now: number): void {
    this.ctx.db.run("UPDATE probes SET ended_at = ?, verdict = ?, judgement = ?, beliefs_after = ? WHERE id = ?", now, verdict, JSON.stringify(j), JSON.stringify(beliefs), pid);
  }

  /** Splits traffic since `from` into the canary (exactly `revert` reverted) and main (everything as now). */
  private cohorts(source: Source, d: IncidentData, revert: string[], from: number, until: number): { canary: { n: number; failures: number }; main: { n: number; failures: number }; other: number } {
    const rows = this.ctx.db.all("SELECT ok, flags FROM bisect_signals WHERE source = ? AND ts >= ? AND ts < ?", source, from, until);
    const canary = { n: 0, failures: 0 }, main = { n: 0, failures: 0 };
    let other = 0;
    const rv = new Set(revert);
    for (const r of rows) {
      let flags: Flags;
      try { flags = JSON.parse(String(r.flags)) as Flags; } catch { other++; continue; }
      let isCanary = true, isMain = true;
      for (const s of d.suspects) {
        const v = flags[s.feature];
        if (v === undefined) { isCanary = false; isMain = false; break; }
        if (!sameValue(v, s.after)) isMain = false;
        if (!sameValue(v, rv.has(s.id) ? s.before : s.after)) isCanary = false;
      }
      const cohort = isCanary && !isMain ? canary : isMain ? main : null;
      if (!cohort) { other++; continue; }
      cohort.n++; if (Number(r.ok) === 0) cohort.failures++;
    }
    return { canary, main, other };
  }

  private async safeTeardownData(d: IncidentData, ctl: FlagControl): Promise<void> {
    if (d.probe && d.canary) { try { await ctl.clearProbe(d.canary, d.probe.applied); } catch { /* reported by caller */ } }
    if (d.canary) { await ctl.teardownCanary(d.canary); d.canary = null; }
    d.probe = null;
  }

  private async safeTeardown(id: number): Promise<void> {
    const inc = this.load(id);
    try { await this.safeTeardownData(inc.data, this.control(inc.source)); } catch (e) { this.say(id, "guardian", "error", `Could not remove the canary: ${e instanceof Error ? e.message : String(e)}. Remove the segment "vs-canary-${id}" by hand.`); }
    this.save(id, inc.data);
  }

  /* ------------------------------------------------------------------------------------- human actions */

  approveEnvelope(id: number, actor: string, confirmation: unknown, reason: unknown, overrides: Partial<Pick<Envelope, "canaryPercent" | "maxRounds" | "maxMinutes">> = {}): void {
    const inc = this.load(id);
    if (inc.state !== "AWAITING_APPROVAL") throw new HttpError(409, "not_awaiting_approval", `Incident #${id} is ${inc.state}, not waiting for an envelope approval`);
    if (confirmation !== `BISECT ${id}`) throw new HttpError(400, "confirmation_required", `Type exactly "BISECT ${id}" to confirm`);
    if (typeof reason !== "string" || reason.trim().length < 5) throw new HttpError(400, "validation_failed", "A reason is required (at least 5 characters)");
    const env = { ...inc.data.envelope! };
    if (overrides.canaryPercent !== undefined) { if (!Number.isInteger(overrides.canaryPercent) || overrides.canaryPercent < 1 || overrides.canaryPercent > 20) throw new HttpError(400, "validation_failed", "canaryPercent must be an integer from 1 to 20"); env.canaryPercent = overrides.canaryPercent; }
    if (overrides.maxRounds !== undefined) { if (!Number.isInteger(overrides.maxRounds) || overrides.maxRounds < 1 || overrides.maxRounds > 20) throw new HttpError(400, "validation_failed", "maxRounds must be an integer from 1 to 20"); env.maxRounds = overrides.maxRounds; }
    if (overrides.maxMinutes !== undefined) { if (!Number.isInteger(overrides.maxMinutes) || overrides.maxMinutes < 5 || overrides.maxMinutes > 240) throw new HttpError(400, "validation_failed", "maxMinutes must be an integer from 5 to 240"); env.maxMinutes = overrides.maxMinutes; }
    const entry = appendEntry(this.ctx, { kind: "bisect.envelope.approved", subjectType: "incident", subjectId: String(id), actor, source: inc.source, summary: `Envelope approved for incident #${id}: ${env.suspects.length} changes, ${env.canaryPercent}% canary, ${env.maxRounds} rounds, ${env.maxMinutes} min. ${reason.trim().slice(0, 160)}`, payload: { envelope: env, reason: reason.trim() } });
    inc.data.envelope = env;
    inc.data.envelopeApproval = { actor, at: this.clock(inc.source), seq: entry.seq, reason: reason.trim() };
    inc.data.waitingOn = null;
    this.say(id, "human", "approved", `${actor} approved the envelope (ledger #${entry.seq}): "${reason.trim()}".`);
    this.save(id, inc.data, "PROBING");
  }

  abort(id: number, actor: string, reason: unknown): Promise<void> {
    return (async () => {
      const inc = this.load(id);
      if (TERMINAL.includes(inc.state) || inc.state === "REMEDIATED") throw new HttpError(409, "not_abortable", `Incident #${id} is ${inc.state}`);
      if (typeof reason !== "string" || reason.trim().length < 5) throw new HttpError(400, "validation_failed", "A reason is required (at least 5 characters)");
      await this.safeTeardown(id);
      this.say(id, "human", "abort", `${actor} stopped the investigation: "${reason.trim()}". Canary removed.`);
      record(this.ctx, { kind: "bisect.aborted", subjectType: "incident", subjectId: String(id), actor, source: inc.source, summary: `Incident #${id} stopped by ${actor}: ${reason.trim().slice(0, 160)}` });
      this.save(id, this.load(id).data, "ABORTED");
    })();
  }

  proposeRemediation(id: number, actor: string, reason: unknown): void {
    const inc = this.load(id);
    if (inc.state !== "IDENTIFIED") throw new HttpError(409, "not_identified", `Incident #${id} is ${inc.state}; a remediation can be proposed once a culprit is confirmed`);
    if (typeof reason !== "string" || reason.trim().length < 10) throw new HttpError(400, "validation_failed", "A rationale is required (at least 10 characters)");
    const r = inc.data.remediation!;
    const entry = appendEntry(this.ctx, { kind: "remediation.proposed", subjectType: "incident", subjectId: String(id), actor, source: inc.source, summary: `Remediation proposed for incident #${id}: restore ${r.restore.map((x) => `${x.feature}=${fmtValue(x.to)}`).join(", ")} for everyone. ${reason.trim().slice(0, 160)}`, payload: { restore: r.restore, reason: reason.trim() } });
    r.proposedBy = actor; r.proposedSeq = entry.seq;
    inc.data.waitingOn = `a second person (not ${actor}) to approve: type "REMEDIATE ${id}"`;
    this.say(id, "human", "proposed", `${actor} proposed the remediation (ledger #${entry.seq}). It needs a different person to approve.`);
    this.save(id, inc.data, "REMEDIATION_PROPOSED");
  }

  async approveRemediation(id: number, actor: string, confirmation: unknown, reason: unknown): Promise<unknown> {
    const inc = this.load(id);
    if (inc.state !== "REMEDIATION_PROPOSED") throw new HttpError(409, "not_proposed", `Incident #${id} is ${inc.state}`);
    const r = inc.data.remediation!;
    if (confirmation !== `REMEDIATE ${id}`) throw new HttpError(400, "confirmation_required", `Type exactly "REMEDIATE ${id}" to confirm`);
    if (typeof reason !== "string" || reason.trim().length < 5) throw new HttpError(400, "validation_failed", "A reason is required (at least 5 characters)");
    if (!this.ctx.cfg.allowSelfApproval && r.proposedBy === actor) throw new HttpError(403, "self_approval_forbidden", "The remediation changes Flagsmith for everyone, so it needs a second person: approve as a different actor (X-VariantShield-Actor).");
    const ctl = this.control(inc.source);
    const culprits = inc.data.suspects.filter((s) => inc.data.conclusion!.ids.includes(s.id));
    appendEntry(this.ctx, { kind: "remediation.approved", subjectType: "incident", subjectId: String(id), actor, refSeq: r.proposedSeq, source: inc.source, summary: `Remediation for incident #${id} approved by ${actor} (proposed by ${r.proposedBy}). ${reason.trim().slice(0, 160)}`, payload: { restore: r.restore, reason: reason.trim() } });
    const result = await ctl.remediate(culprits);
    r.approvedBy = actor; r.result = result;
    const ok = result.restored.every((x) => x.verified);
    appendEntry(this.ctx, { kind: "remediation.executed", subjectType: "incident", subjectId: String(id), actor: `swarm:prober for ${actor}`, source: inc.source, summary: `Remediation for incident #${id} ${ok ? "executed and verified by reading Flagsmith back" : "executed but the read-back did not match"}: ${result.restored.map((x) => `${x.feature}=${fmtValue(x.readBack)}`).join(", ")}`, payload: { result } });
    inc.data.waitingOn = ok ? "the Sentinel to see the failure rate recover" : "a person: the read-back did not match";
    this.say(id, "prober", "remediated", ok ? `Restored ${result.restored.map((x) => `${x.feature} to ${fmtValue(x.readBack)}`).join(" and ")} for everyone; read back from ${ctl.mode === "flagsmith" ? "Flagsmith" : "the simulation"} and verified.` : "The read-back did not match what was written. Check Flagsmith by hand.", result);
    this.save(id, inc.data, "REMEDIATED");
    return result;
  }

  /* ------------------------------------------------------------------------------------- views */

  list(source?: Source): unknown[] {
    const rows = source ? this.ctx.db.all("SELECT id FROM incidents WHERE source = ? ORDER BY id DESC LIMIT 50", source) : this.ctx.db.all("SELECT id FROM incidents ORDER BY id DESC LIMIT 50");
    return rows.map((r) => { const i = this.load(Number(r.id)); return { id: i.id, source: i.source, state: i.state, openedAt: i.openedAt, onsetAt: i.onsetAt, suspects: i.data.suspects.length, rounds: i.data.rounds, conclusion: i.data.conclusion, scenario: i.data.scenario ?? null }; });
  }

  view(id: number): unknown {
    const inc = this.load(id);
    const d = inc.data;
    const inv = involvement(d.beliefs);
    const prior = new Map(priors(d.suspects, inc.onsetAt ?? 0).beliefs.map((b) => [b.key, b.p]));
    const now = this.clock(inc.source);
    const from = (inc.onsetAt ?? now) - 14 * BUCKET_MS;
    const series = this.buckets(inc.source, from, now + BUCKET_MS);
    const probes = this.ctx.db.all("SELECT id, round, revert, started_at, ended_at, verdict, judgement FROM probes WHERE incident_id = ? ORDER BY round", id).map((p) => ({ id: p.id, round: p.round, revert: JSON.parse(String(p.revert)), startedAt: p.started_at, endedAt: p.ended_at, verdict: p.verdict, judgement: p.judgement ? JSON.parse(String(p.judgement)) : null }));
    const messages = this.ctx.db.all("SELECT id, ts, agent, kind, text FROM swarm_messages WHERE incident_id = ? ORDER BY id DESC LIMIT 200", id).reverse();
    const top = [...d.beliefs].sort((a, b) => b.p - a.p).slice(0, 8).map((b) => ({ key: b.key, label: describeKey(d, b.key), kind: b.hypothesis.kind, p: b.p }));
    return {
      id, source: inc.source, state: inc.state, simulated: inc.source === "simulation", scenario: d.scenario ?? null,
      openedAt: inc.openedAt, onsetAt: inc.onsetAt, clock: now, baselineRate: inc.baselineRate, regressionRate: d.regressionRate,
      suspects: d.suspects.map((s) => ({ ...s, prior: prior.get(s.id) ?? 0, involvement: inv[s.id] ?? 0, explanation: d.priorExplanation.find((e) => e.id === s.id) ?? null, inEnvelope: d.envelope?.suspects.includes(s.id) ?? false, reverted: d.probe?.revert.includes(s.id) ?? false })),
      hypotheses: top, noneP: d.beliefs.find((b) => b.key === "none")?.p ?? 0,
      envelope: d.envelope, envelopeApproval: d.envelopeApproval, canary: d.canary, rounds: d.rounds, activeProbe: d.probe ? { round: d.probe.round, kind: d.probe.kind, revert: d.probe.revert, startedAt: d.probe.startedAt, settlesAt: d.probe.startedAt + SETTLE[inc.source] } : null,
      lastJudgement: d.lastJudgement, conclusion: d.conclusion, confirmed: d.confirmed, remediation: d.remediation, waitingOn: TERMINAL.includes(inc.state) ? null : d.waitingOn,
      confirmations: { envelope: `BISECT ${id}`, remediation: `REMEDIATE ${id}` },
      series, probes, messages,
      agents: AGENTS.map((a) => ({ ...a, status: agentStatus(a.id, inc.state, d), last: messages.filter((m) => m.agent === a.id).at(-1)?.text ?? null })),
    };
  }
}

function agentStatus(agent: AgentId, state: IncidentState, d: IncidentData): "working" | "waiting" | "done" | "idle" {
  const probing = state === "PROBING" || state === "CONFIRMING";
  switch (agent) {
    case "sentinel": return state === "REMEDIATED" ? "working" : "done";
    case "archivist": case "profiler": return state === "INVESTIGATING" ? "working" : "done";
    case "guardian": return state === "AWAITING_APPROVAL" ? "waiting" : probing ? "working" : "done";
    case "prober": return probing && !d.probe ? "working" : probing ? "waiting" : state === "REMEDIATION_PROPOSED" ? "waiting" : "idle";
    case "judge": return probing && d.probe ? "working" : d.rounds ? "done" : "idle";
    case "scribe": return state === "IDENTIFIED" || state === "REMEDIATION_PROPOSED" ? "waiting" : "working";
  }
}

const iso = (ms: number): string => new Date(ms).toISOString().slice(11, 19);
const feat = (d: IncidentData, id: string): string => d.suspects.find((s) => s.id === id)?.feature ?? id;
function describeKey(d: IncidentData, key: string): string { return key === "none" ? "none of these changes" : key.split("+").map((k) => feat(d, k)).join(" + "); }
function describeTop(d: IncidentData): string { const c = conclude(d.beliefs); return `${describeKey(d, c.top.key)} (${(c.confidence * 100).toFixed(1)}%)`; }
function pctOf(b: Belief[], key: string): string {
  const p = key === "pairs" ? b.filter((x) => x.hypothesis.kind === "pair").reduce((a, x) => a + x.p, 0) : (b.find((x) => x.key === key)?.p ?? 0);
  return `${(p * 100).toFixed(0)}%`;
}
function healMassOf(b: Belief[], revert: string[]): number { const r = new Set(revert); return b.filter((x) => x.hypothesis.kind !== "none" && x.hypothesis.ids.some((i) => r.has(i))).reduce((a, x) => a + x.p, 0); }
export function fmtValue(v: Suspect["before"]): string { return v.enabled ? (v.value === null || v.value === "" ? "on" : `on (${String(v.value)})`) : "off"; }
