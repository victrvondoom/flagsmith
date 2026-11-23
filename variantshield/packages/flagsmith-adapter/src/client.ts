import { FlagsmithError, kindForStatus } from "./errors.ts";
import { parseExperiment, parseExposures, parsePage, parseResults } from "./parse.ts";
import type {
  ExposureSnapshot, FlagsmithClientConfig, FlagsmithExperiment, FlagsmithExperimentStatus,
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
  private async request(method: "GET" | "POST", url: string, headers: Record<string, string>, body?: unknown): Promise<unknown> {
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
        lastError = new FlagsmithError(kindForStatus(res.status), `Flagsmith ${method} ${new URL(url).pathname} failed with ${res.status}`, {
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
}
