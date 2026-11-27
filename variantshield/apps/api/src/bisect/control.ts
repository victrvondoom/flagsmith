import { createHash } from "node:crypto";
import type { FlagValue, Hypothesis, Suspect } from "../../../../packages/bisect/src/index.ts";
import { mulberry32 } from "../../../../packages/bisect/src/simulate.ts";

/**
 * What the swarm may do to flags. Two implementations: `SimulatedWorld` (in process, labelled SIMULATION, no Flagsmith)
 * and `FlagsmithControl` (flagsmith-control.ts, Flagsmith's own Management API). The swarm only ever calls these methods,
 * and only inside an envelope a person approved.
 */
export interface CanaryHandle { segmentId: number | null; label: string; percent: number }
export interface AppliedProbe { revert: string[]; overrides: { feature: string; featureStateId: number | null; featureSegmentId: number | null }[] }
export interface RemediationResult { restored: { feature: string; before: FlagValue; readBack: FlagValue; verified: boolean }[] }

export interface FlagControl {
  readonly mode: "simulation" | "flagsmith";
  describe(): Record<string, unknown>;
  /** Flag changes in [sinceMs, untilMs], newest last, as suspects (each with the value a revert restores). */
  recentChanges(sinceMs: number, untilMs: number): Promise<Suspect[]>;
  prepareCanary(percent: number, incidentId: number): Promise<CanaryHandle>;
  /** Makes the canary see `before` for exactly these suspects (and `after` for everything else). */
  applyProbe(canary: CanaryHandle, revert: Suspect[]): Promise<AppliedProbe>;
  clearProbe(canary: CanaryHandle, applied: AppliedProbe): Promise<void>;
  teardownCanary(canary: CanaryHandle): Promise<void>;
  /** Restores `before` for everyone in the environment, then reads it back. */
  remediate(suspects: Suspect[]): Promise<RemediationResult>;
}

export type Flags = Record<string, FlagValue>;
export interface Signal { ts: number; identity: string; ok: boolean; flags: Flags }

export const sameValue = (a: FlagValue | undefined, b: FlagValue): boolean => a !== undefined && a.enabled === b.enabled && String(a.value ?? "") === String(b.value ?? "");

/** Deterministic 0..99 bucket, like a percentage-split segment (not Flagsmith's exact hash; simulation only). */
export const bucketOf = (identity: string, salt: string): number => createHash("sha256").update(`${salt}:${identity}`).digest().readUInt32BE(0) % 100;

/* ----------------------------------------------------------------------------------------- simulation */

export interface SimScenario {
  id: string; title: string; description: string;
  truth: Hypothesis;
  baselineRate: number; faultRate: number;
  changes: { feature: string; before: FlagValue; after: FlagValue; minutesBeforeOnset: number; by: string; blastRadius: number }[];
}

const on = (v: FlagValue["value"] = null): FlagValue => ({ enabled: true, value: v });
const off = (v: FlagValue["value"] = null): FlagValue => ({ enabled: false, value: v });

const FRIDAY_DEPLOY: SimScenario["changes"] = [
  { feature: "address_autocomplete", before: off(), after: on(), minutesBeforeOnset: 38, by: "priya@shop", blastRadius: 1 },
  { feature: "promo_banner", before: on("diwali"), after: on("black_friday"), minutesBeforeOnset: 31, by: "marketing-bot", blastRadius: 1 },
  { feature: "search_reranker", before: on("bm25"), after: on("hybrid_v2"), minutesBeforeOnset: 24, by: "sam@shop", blastRadius: 0.5 },
  { feature: "recs_model", before: on("2026-10"), after: on("2026-11"), minutesBeforeOnset: 17, by: "ml-release", blastRadius: 1 },
  { feature: "fast_checkout", before: off(), after: on(), minutesBeforeOnset: 11, by: "lee@shop", blastRadius: 1 },
  { feature: "new_tax_engine", before: off(), after: on(), minutesBeforeOnset: 6, by: "fin-platform", blastRadius: 1 },
  { feature: "dark_mode_default", before: off(), after: on(), minutesBeforeOnset: 2, by: "design@shop", blastRadius: 1 },
];

export const SIM_SCENARIOS: SimScenario[] = [
  {
    id: "interaction", title: "Two changes that only break together",
    description: "Seven flags changed in 40 minutes. Checkout errors jump from 1% to 9%, but only for users who have both fast_checkout and new_tax_engine.",
    truth: { kind: "pair", ids: ["sim:fast_checkout", "sim:new_tax_engine"] }, baselineRate: 0.01, faultRate: 0.09, changes: FRIDAY_DEPLOY,
  },
  {
    id: "single", title: "One bad model rollout",
    description: "Seven flags changed in 40 minutes. The new recommendations model times out and fails 8% of checkouts.",
    truth: { kind: "single", ids: ["sim:recs_model"] }, baselineRate: 0.01, faultRate: 0.08, changes: FRIDAY_DEPLOY,
  },
  {
    id: "not-flags", title: "Not a flag change",
    description: "Seven flags changed, but the errors come from a payment-provider outage. Reverting flags does not help, and the swarm says so.",
    truth: { kind: "none" }, baselineRate: 0.01, faultRate: 0.07, changes: FRIDAY_DEPLOY,
  },
];

/**
 * SIMULATION. An in-process environment: flag defaults, a change log, a canary override and seeded traffic whose failures
 * are decided by a hidden culprit. Time is simulated (`clock`) so an incident plays out in about a minute.
 */
export class SimulatedWorld implements FlagControl {
  readonly mode = "simulation" as const;
  clock: number;
  readonly scenario: SimScenario;
  private readonly defaults = new Map<string, FlagValue>();
  private readonly log: Suspect[] = [];
  private canary: { percent: number; salt: string; overrides: Map<string, FlagValue> } | null = null;
  private readonly rnd: () => number;
  /** Simulated time when the regression starts. */
  readonly onsetAt: number;
  remediated = new Set<string>();

  constructor(scenario: SimScenario, startMs: number, seed = 42) {
    this.scenario = scenario;
    this.rnd = mulberry32(seed);
    this.clock = startMs;
    // The regression starts 12 simulated minutes after the world begins; the changes are placed before that.
    this.onsetAt = startMs + 12 * 60_000;
    for (const c of scenario.changes) {
      this.defaults.set(c.feature, c.after);
      this.log.push({ id: `sim:${c.feature}`, feature: c.feature, before: c.before, after: c.after, changedAt: this.onsetAt - c.minutesBeforeOnset * 60_000, changedBy: c.by, blastRadius: c.blastRadius });
    }
    this.log.sort((a, b) => a.changedAt - b.changedAt);
  }

  describe(): Record<string, unknown> { return { mode: "simulation", scenario: this.scenario.id, label: "SIMULATION: in-process flags and synthetic traffic, no Flagsmith" }; }

  /** Flags as served to one identity right now. */
  flagsFor(identity: string, at = this.clock): Flags {
    const out: Flags = {};
    for (const s of this.log) {
      const live = s.changedAt <= at && !this.remediated.has(s.feature);
      let v = live ? s.after : s.before;
      if (live && this.canary && this.canary.overrides.has(s.feature) && bucketOf(identity, this.canary.salt) < this.canary.percent) v = this.canary.overrides.get(s.feature)!;
      out[s.feature] = v;
    }
    return out;
  }

  private failing(flags: Flags, at: number): boolean {
    if (at < this.onsetAt) return false;
    const t = this.scenario.truth;
    if (t.kind === "none") return true;
    const byId = new Map(this.log.map((s) => [s.id, s]));
    return t.ids.every((id) => { const s = byId.get(id)!; return sameValue(flags[s.feature], s.after); });
  }

  /** Advances the clock by `ms` and returns the requests served in that time. */
  traffic(ms: number, requests: number): Signal[] {
    const out: Signal[] = [];
    for (let i = 0; i < requests; i++) {
      const ts = this.clock + Math.floor((i / requests) * ms);
      const identity = `user-${Math.floor(this.rnd() * 20_000)}`;
      const flags = this.flagsFor(identity, ts);
      const p = this.failing(flags, ts) ? this.scenario.faultRate : this.scenario.baselineRate;
      out.push({ ts, identity, ok: this.rnd() >= p, flags });
    }
    this.clock += ms;
    return out;
  }

  async recentChanges(sinceMs: number, untilMs: number): Promise<Suspect[]> { return this.log.filter((s) => s.changedAt >= sinceMs && s.changedAt <= untilMs).map((s) => structuredClone(s)); }
  async prepareCanary(percent: number, incidentId: number): Promise<CanaryHandle> {
    this.canary = { percent, salt: `vs-canary-${incidentId}`, overrides: new Map() };
    return { segmentId: null, label: `simulated canary segment (${percent}% split)`, percent };
  }
  async applyProbe(_c: CanaryHandle, revert: Suspect[]): Promise<AppliedProbe> {
    if (!this.canary) throw new Error("canary not prepared");
    this.canary.overrides = new Map(revert.map((s) => [s.feature, s.before]));
    return { revert: revert.map((s) => s.id), overrides: revert.map((s) => ({ feature: s.feature, featureStateId: null, featureSegmentId: null })) };
  }
  async clearProbe(): Promise<void> { if (this.canary) this.canary.overrides = new Map(); }
  async teardownCanary(): Promise<void> { this.canary = null; }
  async remediate(suspects: Suspect[]): Promise<RemediationResult> {
    for (const s of suspects) this.remediated.add(s.feature);
    return { restored: suspects.map((s) => { const rb = this.flagsFor("read-back")[s.feature]!; return { feature: s.feature, before: s.before, readBack: rb, verified: sameValue(rb, s.before) }; }) };
  }
}
