import { createHash } from "node:crypto";
import { FlagsmithError, kindForStatus } from "./errors.ts";
import { parseExperiment, parseExposures, parsePage, parseResults } from "./parse.ts";
import type {
  AssignmentConfig, AssignmentConfigState, ExposureSnapshot, FlagsmithClientConfig, FlagsmithExperiment, FlagsmithExperimentStatus,
  IdentityAssignment, ResultsSnapshot, SdkEvent,
} from "./types.ts";

const RETRYABLE = new Set([429, 502, 503, 504]);
const DEFAULT_RETRY = { retries: 3, baseDelayMs: 250, maxDelayMs: 4000 };

export function normaliseBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch (cause) {
    throw new FlagsmithError("config", `FLAGSMITH_URL is not a valid URL: ${input}`, { cause });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new FlagsmithError("config", "FLAGSMITH_URL must be http(s)");
  return url.origin + url.pathname.replace(/\/+$/, "").replace(/\/api(\/v1)?$/, "");
}

export class FlagsmithClient {
  private readonly base: string;
  private readonly cfg: FlagsmithClientConfig;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(cfg: FlagsmithClientConfig) {
    if (!cfg.environmentKey) throw new FlagsmithError("config", "environmentKey is required");
    this.cfg = cfg;
    this.base = normaliseBaseUrl(cfg.baseUrl);
    this.doFetch = cfg.fetch ?? globalThis.fetch;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Never returns the credential; safe to log. */
  describe(): { baseUrl: string; environmentKey: string; adminConfigured: boolean } {
    const k = this.cfg.environmentKey;
    return { baseUrl: this.base, environmentKey: `${k.slice(0, 4)}…`, adminConfigured: Boolean(this.cfg.admin) };
  }

  private adminHeaders(): Record<string, string> {
    if (!this.cfg.admin) throw new FlagsmithError("config", "A Flagsmith Management API credential is required for this operation");
    return { Authorization: `${this.cfg.admin.scheme} ${this.cfg.admin.value}` };
  }

  private envUrl(path: string): string {
    return `${this.base}/api/v1/environments/${encodeURIComponent(this.cfg.environmentKey)}${path}`;
  }

  /** Low-level request. Retries only idempotent reads on 429/502/503/504 and network errors. */
  private async request(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, headers: Record<string, string>, body?: unknown): Promise<unknown> {
    const retry = this.cfg.retry ?? DEFAULT_RETRY;
    const attempts = method === "GET" ? retry.retries + 1 : 1;
    let lastError: FlagsmithError | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
        await this.sleep(Math.max(lastError?.retryAfterMs ?? 0, backoff / 2 + Math.random() * (backoff / 2)));
      }
      try {
        const res = await this.doFetch(url, {
          method,
          headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
        });
        const text = await res.text();
        let json: unknown = null;
        if (text) {
          try { json = JSON.parse(text); } catch { json = text; }
        }
        if (res.ok) return json;
        const retryAfter = Number(res.headers.get("retry-after"));
        const why = res.status === 400 && json && typeof json === "object" ? `: ${JSON.stringify(json).slice(0, 300)}` : "";
        lastError = new FlagsmithError(kindForStatus(res.status), `Flagsmith ${method} ${new URL(url).pathname} failed with ${res.status}${why}`, {
          status: res.status, detail: json, retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
        });
        if (!RETRYABLE.has(res.status)) throw lastError;
      } catch (e) {
        if (e instanceof FlagsmithError) {
          if (!RETRYABLE.has(e.status ?? 0)) throw e;
          lastError = e;
          continue;
        }
        const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        lastError = new FlagsmithError(timedOut ? "timeout" : "network", `Flagsmith ${method} ${new URL(url).pathname}: ${timedOut ? "timed out" : "network error"}`, { cause: e });
      }
    }
    throw lastError ?? new FlagsmithError("network", "request failed");
  }

  async listExperiments(opts: { status?: FlagsmithExperimentStatus; search?: string; maxPages?: number } = {}): Promise<FlagsmithExperiment[]> {
    const q = new URLSearchParams();
    if (opts.status) q.set("status", opts.status);
    if (opts.search) q.set("q", opts.search);
    let url: string | null = this.envUrl(`/experiments/${q.size ? `?${q}` : ""}`);
    const out: FlagsmithExperiment[] = [];
    for (let page = 0; url && page < (opts.maxPages ?? 20); page++) {
      const { results, next } = parsePage(await this.request("GET", url, this.adminHeaders()));
      out.push(...results.map(parseExperiment));
      url = next;
    }
    return out;
  }

  async getExperiment(id: number): Promise<FlagsmithExperiment> {
    return parseExperiment(await this.request("GET", this.envUrl(`/experiments/${id}/`), this.adminHeaders()));
  }

  async getResults(id: number, opts: { primaryMetricId?: number } = {}): Promise<ResultsSnapshot | null> {
    const raw = await this.request("GET", this.envUrl(`/experiments/${id}/results/`), this.adminHeaders());
    return parseResults(raw, { winProbability: this.cfg.winProbability ?? 0.95, ...opts });
  }

  async getExposures(id: number): Promise<ExposureSnapshot | null> {
    return parseExposures(await this.request("GET", this.envUrl(`/experiments/${id}/exposures/`), this.adminHeaders()));
  }

  /** Asks Flagsmith to recompute results/exposures (202 Accepted). Flagsmith throttles refreshes to once per 5 minutes. */
  async refresh(id: number, what: "results" | "exposures"): Promise<void> {
    await this.request("POST", this.envUrl(`/experiments/${id}/${what}/refresh/`), this.adminHeaders(), {});
  }

  /** Documented lifecycle operations. Mutations are never retried automatically. */
  async transition(id: number, action: "start" | "pause" | "complete"): Promise<FlagsmithExperiment> {
    const raw = await this.request("POST", this.envUrl(`/experiments/${id}/${action}/`), this.adminHeaders(), {});
    return parseExperiment(raw);
  }

  /**
   * Reads what decides assignment for a multivariate flag in this environment: the default state and any segment override
   * (an experiment's rollout is a system-segment override), with each option's percentage. The fingerprint changes when
   * weights, enabled state or the option set change. Uses the Management API; verified against Flagsmith's own endpoints.
   */
  async getAssignmentConfig(featureName: string): Promise<AssignmentConfig> {
    const headers = this.adminHeaders();
    const env = (await this.request("GET", `${this.base}/api/v1/environments/${encodeURIComponent(this.cfg.environmentKey)}/`, headers)) as { id?: unknown; name?: unknown; project?: unknown };
    if (typeof env?.id !== "number" || typeof env.project !== "number") throw new FlagsmithError("contract", "Unexpected Flagsmith response: environment has no id/project", { detail: env });
    // `/features/featurestates/` does not filter by feature_name (only environment, feature, feature_segment), so resolve
    // the feature id first through the environment endpoint, which does accept feature_name.
    const def = parsePage(await this.request("GET", `${this.envUrl("/featurestates/")}?${new URLSearchParams({ feature_name: featureName })}`, headers)).results;
    const featureId = (def.find((r) => typeof (r as { feature?: unknown }).feature === "number") as { feature?: number } | undefined)?.feature;
    if (typeof featureId !== "number") throw new FlagsmithError("not_found", `Flagsmith has no feature state for "${featureName}" in this environment`);
    const q = new URLSearchParams({ environment: String(env.id), feature: String(featureId) });
    const raw: unknown[] = [];
    let url: string | null = `${this.base}/api/v1/features/featurestates/?${q}`;
    for (let page = 0; url && page < 5; page++) { const { results, next } = parsePage(await this.request("GET", url, headers)); raw.push(...results.filter((r) => (r as { identity?: unknown }).identity == null)); url = next; }
    if (raw.length === 0) throw new FlagsmithError("not_found", `Flagsmith has no feature state for "${featureName}" in this environment`);
    const feature = (await this.request("GET", `${this.base}/api/v1/projects/${env.project}/features/${featureId}/`, headers)) as { multivariate_options?: { id: number; string_value?: string | null; integer_value?: number | null; boolean_value?: boolean | null }[] };
    const valueOf = new Map((feature.multivariate_options ?? []).map((o) => [o.id, String(o.string_value ?? o.integer_value ?? o.boolean_value ?? o.id)]));
    const states: AssignmentConfigState[] = raw.map((r) => {
      const s = r as { enabled?: unknown; feature_segment?: unknown; feature_state_value?: unknown; multivariate_feature_state_values?: { multivariate_feature_option: number; percentage_allocation: number }[] };
      const v = s.feature_state_value;
      const dv = typeof v === "object" && v !== null ? ((v as { string_value?: unknown; integer_value?: unknown; boolean_value?: unknown }).string_value ?? (v as { integer_value?: unknown }).integer_value ?? (v as { boolean_value?: unknown }).boolean_value ?? null) : v ?? null;
      return {
        segmentId: typeof s.feature_segment === "number" ? s.feature_segment : null, enabled: s.enabled === true, defaultValue: dv === null ? null : String(dv),
        weights: (s.multivariate_feature_state_values ?? []).map((w) => ({ value: valueOf.get(w.multivariate_feature_option) ?? String(w.multivariate_feature_option), percentage: w.percentage_allocation })).sort((a, b) => a.value.localeCompare(b.value)),
      };
    }).sort((a, b) => (a.segmentId ?? -1) - (b.segmentId ?? -1));
    const fingerprint = createHash("sha256").update(JSON.stringify({ f: featureName, e: env.id, states })).digest("hex").slice(0, 16);
    return { featureName, environmentId: env.id, environmentName: typeof env.name === "string" ? env.name : String(env.id), states, fingerprint };
  }

  /** Reads the variant Flagsmith actually serves to an identity (SDK identities endpoint). */
  async getIdentityAssignment(identifier: string, featureKey: string): Promise<IdentityAssignment> {
    const url = `${this.base}/api/v1/identities/?identifier=${encodeURIComponent(identifier)}`;
    const raw = await this.request("GET", url, { "X-Environment-Key": this.cfg.environmentKey });
    const flags = typeof raw === "object" && raw !== null && Array.isArray((raw as { flags?: unknown }).flags) ? (raw as { flags: unknown[] }).flags : null;
    if (!flags) throw new FlagsmithError("contract", "Unexpected Flagsmith response: identities response has no flags array", { detail: raw });
    for (const f of flags) {
      const flag = f as { feature?: { name?: unknown }; enabled?: unknown; feature_state_value?: unknown };
      if (flag.feature?.name !== featureKey) continue;
      const enabled = flag.enabled === true;
      const value = flag.feature_state_value;
      if (!enabled) return { featureKey, variantKey: null, enabled, reason: "flag_disabled" };
      if (typeof value !== "string" || value === "") return { featureKey, variantKey: null, enabled, reason: "no_value" };
      return { featureKey, variantKey: value, enabled, reason: null };
    }
    return { featureKey, variantKey: null, enabled: false, reason: "flag_not_found" };
  }

  /** Sends experiment events to the SDK events endpoint (Flagsmith database or ingestion service). */
  async sendEvents(events: SdkEvent[], opts: { eventsUrl?: string } = {}): Promise<void> {
    const url = opts.eventsUrl ?? `${this.base}/api/v1/events/`;
    await this.request("POST", url, { "X-Environment-Key": this.cfg.environmentKey }, {
      events: events.map((e) => ({
        event: e.event, identifier: e.identifier, timestamp: e.timestampMs,
        ...(e.featureName === undefined ? {} : { feature_name: e.featureName }),
        ...(e.value === undefined ? {} : { value: e.value }),
      })),
    });
  }

  async sendExposure(identifier: string, featureKey: string, variantKey: string, timestampMs = Date.now()): Promise<void> {
    await this.sendEvents([{ event: "$flag_exposure", featureName: featureKey, identifier, timestampMs, value: variantKey }]);
  }

  /* ----------------------------------------------------------------------------- flag control (incident bisection)
   * Verified against Flagsmith's source (api/features/future, api/segments, api/audit). Mutations are never retried. */

  private envInfo: { id: number; project: number; name: string; v2: boolean } | null = null;

  /** The configured environment: numeric id, project id, name and whether v2 feature versioning is on. */
  async environment(): Promise<{ id: number; project: number; name: string; v2: boolean }> {
    if (this.envInfo) return this.envInfo;
    const env = (await this.request("GET", this.envUrl("/"), this.adminHeaders())) as { id?: unknown; project?: unknown; name?: unknown; use_v2_feature_versioning?: unknown };
    if (typeof env?.id !== "number" || typeof env.project !== "number") throw new FlagsmithError("contract", "Unexpected Flagsmith response: environment has no id/project", { detail: env });
    this.envInfo = { id: env.id, project: env.project, name: typeof env.name === "string" ? env.name : String(env.id), v2: env.use_v2_feature_versioning === true };
    return this.envInfo;
  }

  /** Feature id by exact name in this environment's project. */
  async featureId(name: string): Promise<number> {
    const { project } = await this.environment();
    const { results } = parsePage(await this.request("GET", `${this.base}/api/v1/projects/${project}/features/?${new URLSearchParams({ search: name, page_size: "100" })}`, this.adminHeaders()));
    const f = results.find((r) => (r as { name?: unknown }).name === name) as { id?: unknown } | undefined;
    if (typeof f?.id !== "number") throw new FlagsmithError("not_found", `No feature named "${name}" in project ${project}`);
    return f.id;
  }

  /** Current flag state (environment default and segment overrides), via `/api/__future__/` (works with and without v2 versioning). */
  async getFlagState(featureId: number): Promise<FlagState> {
    const raw = await this.request("GET", `${this.base}/api/__future__/environments/${encodeURIComponent(this.cfg.environmentKey)}/features/${featureId}/`, this.adminHeaders());
    return parseFlagState(raw);
  }

  /** Merges into the flag state (PATCH, never PUT: PUT deletes overrides it does not list). */
  async patchFlagState(featureId: number, body: { environment_default?: FlagStateWrite; segment_overrides?: (FlagStateWrite & { segment: { id: number }; priority?: number })[] }): Promise<FlagState> {
    const raw = await this.request("PATCH", `${this.base}/api/__future__/environments/${encodeURIComponent(this.cfg.environmentKey)}/features/${featureId}/`, this.adminHeaders(), body);
    return parseFlagState(raw);
  }

  async deleteSegmentOverride(featureId: number, segmentId: number): Promise<void> {
    await this.request("DELETE", `${this.base}/api/__future__/environments/${encodeURIComponent(this.cfg.environmentKey)}/features/${featureId}/segment-overrides/${segmentId}/`, this.adminHeaders());
  }

  /**
   * Creates a segment that holds `percent`% of identities (Flagsmith PERCENTAGE_SPLIT on the identity key). The serializer
   * refuses a blank property, so the identity key is addressed by JSONPath (verified on a real Flagsmith: 35 of 400
   * identities matched a 10% split).
   */
  async createPercentageSegment(name: string, percent: number): Promise<{ id: number; name: string }> {
    const { project } = await this.environment();
    const raw = (await this.request("POST", `${this.base}/api/v1/projects/${project}/segments/`, this.adminHeaders(), {
      name, project, description: "Temporary canary created by VariantShield incident bisection. Safe to delete when the incident is closed.",
      rules: [{ type: "ALL", rules: [{ type: "ANY", rules: [], conditions: [{ property: "$.identity.key", operator: "PERCENTAGE_SPLIT", value: String(percent) }] }], conditions: [] }],
    })) as { id?: unknown; name?: unknown };
    if (typeof raw?.id !== "number") throw new FlagsmithError("contract", "Unexpected Flagsmith response: segment has no id", { detail: raw });
    return { id: raw.id, name: String(raw.name ?? name) };
  }

  async deleteSegment(id: number): Promise<void> {
    const { project } = await this.environment();
    await this.request("DELETE", `${this.base}/api/v1/projects/${project}/segments/${id}/`, this.adminHeaders());
  }

  /** Project audit log entries for this environment created at or after `sinceMs` (newest first, up to `maxPages`). */
  async listAudit(sinceMs: number, maxPages = 5): Promise<AuditEntry[]> {
    const { project, id: envId } = await this.environment();
    const out: AuditEntry[] = [];
    let url: string | null = `${this.base}/api/v1/projects/${project}/audit/?${new URLSearchParams({ environments: String(envId) })}`;
    for (let page = 0; url && page < maxPages; page++) {
      const { results, next } = parsePage(await this.request("GET", url, this.adminHeaders()));
      let older = false;
      for (const r of results) {
        const e = r as { id?: unknown; created_date?: unknown; log?: unknown; related_object_type?: unknown; related_object_id?: unknown; author?: { email?: unknown } | null };
        const at = Date.parse(String(e.created_date));
        if (!Number.isFinite(at)) continue;
        if (at < sinceMs) { older = true; continue; }
        out.push({ id: Number(e.id), at, log: String(e.log ?? ""), relatedObjectType: String(e.related_object_type ?? ""), relatedObjectId: typeof e.related_object_id === "number" ? e.related_object_id : null, author: typeof e.author?.email === "string" ? e.author.email : "api key" });
      }
      url = older ? null : next;
    }
    return out;
  }

  /** One audit entry with `change_details` ([{field, old, new}]); Flagsmith fills these for v1 feature-state updates. */
  async getAuditDetail(id: number): Promise<{ changeType: string; changes: { field: string; old: unknown; new: unknown }[] }> {
    const { project } = await this.environment();
    const raw = (await this.request("GET", `${this.base}/api/v1/projects/${project}/audit/${id}/`, this.adminHeaders())) as { change_type?: unknown; change_details?: unknown };
    const changes = Array.isArray(raw?.change_details) ? (raw.change_details as { field?: unknown; old?: unknown; new?: unknown }[]).map((c) => ({ field: String(c.field), old: c.old, new: c.new })) : [];
    return { changeType: String(raw?.change_type ?? "UNKNOWN"), changes };
  }

  /** Environment defaults for every flag (SDK `/api/v1/flags/`, environment key only), keyed by feature name. */
  async getEnvironmentFlags(): Promise<Record<string, { id: number; enabled: boolean; value: string | number | boolean | null }>> {
    const raw = await this.request("GET", `${this.base}/api/v1/flags/`, { "X-Environment-Key": this.cfg.environmentKey });
    if (!Array.isArray(raw)) throw new FlagsmithError("contract", "Unexpected Flagsmith response: /api/v1/flags/ is not a list", { detail: raw });
    const out: Record<string, { id: number; enabled: boolean; value: string | number | boolean | null }> = {};
    for (const f of raw) {
      const x = f as { feature?: { id?: unknown; name?: unknown }; enabled?: unknown; feature_state_value?: unknown };
      if (typeof x.feature?.name !== "string" || typeof x.feature.id !== "number") continue;
      const v = x.feature_state_value;
      out[x.feature.name] = { id: x.feature.id, enabled: x.enabled === true, value: v === "" || v === undefined ? null : typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null };
    }
    return out;
  }

  /** Every flag Flagsmith serves to one identity (SDK identities endpoint), as {feature: {enabled, value}}. */
  async getIdentityFlags(identifier: string): Promise<Record<string, { enabled: boolean; value: string | number | boolean | null }>> {
    const raw = await this.request("GET", `${this.base}/api/v1/identities/?identifier=${encodeURIComponent(identifier)}`, { "X-Environment-Key": this.cfg.environmentKey });
    const flags = typeof raw === "object" && raw !== null && Array.isArray((raw as { flags?: unknown }).flags) ? (raw as { flags: unknown[] }).flags : null;
    if (!flags) throw new FlagsmithError("contract", "Unexpected Flagsmith response: identities response has no flags array", { detail: raw });
    const out: Record<string, { enabled: boolean; value: string | number | boolean | null }> = {};
    for (const f of flags) {
      const x = f as { feature?: { name?: unknown }; enabled?: unknown; feature_state_value?: unknown };
      if (typeof x.feature?.name !== "string") continue;
      const v = x.feature_state_value;
      out[x.feature.name] = { enabled: x.enabled === true, value: typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null };
    }
    return out;
  }
}

export interface FlagStateWrite { enabled?: boolean; value?: { type: "string" | "integer" | "boolean"; value: string } | null }
export interface FlagStateView { enabled: boolean; value: string | number | boolean | null }
export interface FlagState { environmentDefault: FlagStateView; segmentOverrides: (FlagStateView & { segmentId: number; priority: number })[] }
export interface AuditEntry { id: number; at: number; log: string; relatedObjectType: string; relatedObjectId: number | null; author: string }

function parseFlagValue(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  const o = v as { type?: unknown; value?: unknown };
  if (typeof o !== "object" || o.value === undefined || o.value === null) return null;
  const s = String(o.value);
  if (o.type === "integer") { const n = Number(s); return Number.isFinite(n) ? n : s; }
  if (o.type === "boolean") return s === "true" || s === "True";
  return s;
}

export function parseFlagState(raw: unknown): FlagState {
  const r = raw as { environment_default?: { enabled?: unknown; value?: unknown }; segment_overrides?: { segment?: { id?: unknown }; priority?: unknown; enabled?: unknown; value?: unknown }[] };
  if (typeof r !== "object" || r === null || typeof r.environment_default !== "object" || r.environment_default === null) throw new FlagsmithError("contract", "Unexpected Flagsmith response: flag state has no environment_default", { detail: raw });
  return {
    environmentDefault: { enabled: r.environment_default.enabled === true, value: parseFlagValue(r.environment_default.value) },
    segmentOverrides: (r.segment_overrides ?? []).map((o) => ({ segmentId: Number(o.segment?.id), priority: Number(o.priority ?? 0), enabled: o.enabled === true, value: parseFlagValue(o.value) })),
  };
}

/** The typed value the future API expects, from a plain flag value. */
export function toFlagValue(v: string | number | boolean | null): FlagStateWrite["value"] {
  if (v === null) return null;
  if (typeof v === "boolean") return { type: "boolean", value: String(v) };
  if (typeof v === "number" && Number.isInteger(v)) return { type: "integer", value: String(v) };
  return { type: "string", value: String(v) };
}
