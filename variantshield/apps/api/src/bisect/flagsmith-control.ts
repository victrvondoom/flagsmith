import type { Db } from "../db.ts";
import { FlagsmithError, toFlagValue, type FlagsmithClient, type FlagStateView } from "../../../../packages/flagsmith-adapter/src/index.ts";
import type { FlagValue, Suspect } from "../../../../packages/bisect/src/index.ts";
import { sameValue, type AppliedProbe, type CanaryHandle, type FlagControl, type RemediationResult } from "./control.ts";

/**
 * Flag control through Flagsmith's own Management API (verified against api/features/future, api/segments, api/audit):
 *  - suspects: FLAG_UPDATED webhooks recorded in `flag_changes` (they carry previous and new state), plus the project
 *    audit log's change details for environment-default changes (v1 versioning) as a fallback;
 *  - canary: a segment with one PERCENTAGE_SPLIT condition on the identity key;
 *  - probe: a segment override per reverted feature, set to the value it had before (PATCH /api/__future__/...);
 *  - remediation: the environment default restored with PATCH, then read back.
 * Identity overrides still win over segment overrides; identities that have one are reported by the app's own flags
 * and fall out of both cohorts, so they cannot bias a probe.
 */
export class FlagsmithControl implements FlagControl {
  readonly mode = "flagsmith" as const;
  private readonly fs: FlagsmithClient;
  private readonly db: Db;
  private readonly ids = new Map<string, number>();

  constructor(fs: FlagsmithClient, db: Db) { this.fs = fs; this.db = db; }

  describe(): Record<string, unknown> { return { mode: "flagsmith", ...this.fs.describe() }; }

  private snapshot: Map<string, FlagValue & { id: number }> | null = null;

  /**
   * Flag watcher: snapshots every environment default (SDK /api/v1/flags/) and records each difference from the previous
   * snapshot in `flag_changes`. Works on every Flagsmith plan and network, unlike webhooks (Flagsmith refuses webhook URLs on
   * private networks) and the audit API (self-hosted open-source organisations default to zero days of audit visibility).
   * A change is dated at the poll that saw it, so its time is accurate to the poll interval.
   */
  async watch(nowMs: number): Promise<number> {
    const flags = await this.fs.getEnvironmentFlags();
    const prev = this.snapshot;
    this.snapshot = new Map(Object.entries(flags).map(([k, v]) => [k, { id: v.id, enabled: v.enabled, value: v.value }]));
    if (!prev) return 0;
    let n = 0;
    for (const [feature, now] of this.snapshot) {
      const was = prev.get(feature);
      if (!was || sameValue(was, now)) continue;
      this.ids.set(feature, now.id);
      this.db.run("INSERT INTO flag_changes (received_at, changed_at, feature, feature_id, before, after, changed_by, source) VALUES (?,?,?,?,?,?,?,?)", nowMs, nowMs, feature, now.id, JSON.stringify({ enabled: was.enabled, value: was.value }), JSON.stringify({ enabled: now.enabled, value: now.value }), "observed by flag watcher", "poll");
      n++;
    }
    return n;
  }

  private async idOf(feature: string): Promise<number> {
    const known = this.ids.get(feature);
    if (known !== undefined) return known;
    const id = await this.fs.featureId(feature);
    this.ids.set(feature, id);
    return id;
  }

  async recentChanges(sinceMs: number, untilMs: number): Promise<Suspect[]> {
    type Change = { feature: string; featureId: number | null; at: number; before: FlagValue; after: FlagValue; by: string; via: string };
    const changes: Change[] = this.db.all("SELECT * FROM flag_changes WHERE changed_at >= ? AND changed_at <= ? ORDER BY changed_at", sinceMs, untilMs).map((r) => ({
      feature: String(r.feature), featureId: r.feature_id === null ? null : Number(r.feature_id), at: Number(r.changed_at), before: JSON.parse(String(r.before)) as FlagValue, after: JSON.parse(String(r.after)) as FlagValue, by: String(r.changed_by), via: String(r.source),
    }));
    // Audit fallback: environment-default updates carry change_details in v1 versioning.
    try {
      const entries = await this.fs.listAudit(sinceMs);
      for (const e of entries.filter((x) => x.at <= untilMs)) {
        const m = e.log.match(/^(Flag state|Remote config value) updated for feature: (.+)$/);
        if (!m) continue;
        const feature = m[2]!;
        if (changes.some((c) => c.feature === feature && Math.abs(c.at - e.at) < 15_000)) continue; // already known from a webhook or the watcher
        const detail = await this.fs.getAuditDetail(e.id);
        for (const c of detail.changes) {
          if (c.field === "enabled") changes.push({ feature, featureId: null, at: e.at, before: { enabled: c.old === true, value: null }, after: { enabled: c.new === true, value: null }, by: e.author, via: "audit:enabled" });
          else if (/_value$/.test(c.field)) changes.push({ feature, featureId: null, at: e.at, before: { enabled: true, value: scalar(c.old) }, after: { enabled: true, value: scalar(c.new) }, by: e.author, via: "audit:value" });
        }
      }
    } catch (e) {
      if (!(e instanceof FlagsmithError) || (e.kind !== "forbidden" && e.kind !== "not_found")) throw e;
    }
    // One suspect per feature: before = the state just before its latest change (what a revert restores), after = what is served now.
    const byFeature = new Map<string, Change[]>();
    for (const c of changes.sort((a, b) => a.at - b.at)) byFeature.set(c.feature, [...(byFeature.get(c.feature) ?? []), c]);
    const out: Suspect[] = [];
    for (const [feature, list] of byFeature) {
      const featureId = list.find((c) => c.featureId !== null)?.featureId ?? await this.idOf(feature);
      this.ids.set(feature, featureId);
      const now = (await this.fs.getFlagState(featureId)).environmentDefault;
      const enabledChange = [...list].reverse().find((c) => c.via !== "audit:value");
      const valueChange = [...list].reverse().find((c) => c.via !== "audit:enabled");
      const before: FlagValue = { enabled: enabledChange ? enabledChange.before.enabled : now.enabled, value: valueChange ? valueChange.before.value : now.value };
      const after: FlagValue = { enabled: now.enabled, value: now.value };
      if (sameValue(before, after)) continue; // changed and changed back
      const last = list[list.length - 1]!;
      out.push({ id: `fs:${featureId}`, feature, before, after, changedAt: last.at, changedBy: last.by, blastRadius: 1, notes: [`${list.length} change(s) recorded (${[...new Set(list.map((c) => c.via))].join(", ")})`] });
    }
    return out.sort((a, b) => a.changedAt - b.changedAt);
  }

  async prepareCanary(percent: number, incidentId: number): Promise<CanaryHandle> {
    const seg = await this.fs.createPercentageSegment(`vs-canary-${incidentId}`, percent);
    return { segmentId: seg.id, label: `Flagsmith segment "${seg.name}" (#${seg.id}, ${percent}% of identities by percentage split)`, percent };
  }

  async applyProbe(canary: CanaryHandle, revert: Suspect[]): Promise<AppliedProbe> {
    const overrides: AppliedProbe["overrides"] = [];
    for (const s of revert) {
      const fid = await this.idOf(s.feature);
      await this.fs.patchFlagState(fid, { segment_overrides: [{ segment: { id: canary.segmentId! }, priority: 0, enabled: s.before.enabled, value: toFlagValue(s.before.value) }] });
      overrides.push({ feature: s.feature, featureStateId: null, featureSegmentId: canary.segmentId });
    }
    return { revert: revert.map((s) => s.id), overrides };
  }

  async clearProbe(canary: CanaryHandle, applied: AppliedProbe): Promise<void> {
    for (const o of applied.overrides) {
      try { await this.fs.deleteSegmentOverride(await this.idOf(o.feature), canary.segmentId!); } catch (e) { if (!(e instanceof FlagsmithError && e.kind === "not_found")) throw e; }
    }
  }

  async teardownCanary(canary: CanaryHandle): Promise<void> {
    if (canary.segmentId === null) return;
    try { await this.fs.deleteSegment(canary.segmentId); } catch (e) { if (!(e instanceof FlagsmithError && e.kind === "not_found")) throw e; }
  }

  async remediate(suspects: Suspect[]): Promise<RemediationResult> {
    const restored: RemediationResult["restored"] = [];
    for (const s of suspects) {
      const fid = await this.idOf(s.feature);
      await this.fs.patchFlagState(fid, { environment_default: { enabled: s.before.enabled, value: toFlagValue(s.before.value) } });
      const back: FlagStateView = (await this.fs.getFlagState(fid)).environmentDefault;
      restored.push({ feature: s.feature, before: s.before, readBack: back, verified: sameValue(back, s.before) });
    }
    return { restored };
  }
}

function scalar(v: unknown): string | number | boolean | null { return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null; }

/** Turns a Flagsmith FLAG_UPDATED webhook body into a recorded change (environment defaults only). Returns null when not applicable. */
export function changeFromWebhook(body: unknown): { feature: string; featureId: number; changedAt: number; before: FlagValue; after: FlagValue; changedBy: string } | null {
  const b = body as { event_type?: unknown; data?: { new_state?: WebhookState | null; previous_state?: WebhookState | null; changed_by?: unknown; timestamp?: unknown } };
  if (b?.event_type !== "FLAG_UPDATED" || !b.data?.new_state) return null;
  const n = b.data.new_state, p = b.data.previous_state;
  if (n.identity || n.identity_identifier || n.feature_segment) return null; // overrides are not environment-wide changes
  if (!p) return null;
  const at = Date.parse(String(b.data.timestamp ?? ""));
  if (typeof n.feature?.name !== "string" || typeof n.feature.id !== "number") return null;
  return { feature: n.feature.name, featureId: n.feature.id, changedAt: Number.isFinite(at) ? at : Date.now(), before: { enabled: p.enabled === true, value: scalar(p.feature_state_value) }, after: { enabled: n.enabled === true, value: scalar(n.feature_state_value) }, changedBy: typeof b.data.changed_by === "string" ? b.data.changed_by : "unknown" };
}
interface WebhookState { feature?: { id?: unknown; name?: unknown }; identity?: unknown; identity_identifier?: unknown; feature_segment?: unknown; enabled?: unknown; feature_state_value?: unknown }
