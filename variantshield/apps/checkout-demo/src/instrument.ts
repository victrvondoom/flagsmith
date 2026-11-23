import { randomUUID } from "node:crypto";

export type DemoEventType = "checkout_started" | "checkout_completed" | "payment_failed" | "duplicate_submit" | "checkout_latency" | "http_request";

export interface Assignment {
  variantKey: string | null;
  /** "flagsmith" only when Flagsmith served the value. Anything else means telemetry must not claim a variant. */
  source: "flagsmith" | "unassigned" | "override";
}

export interface EmitInput {
  type: DemoEventType;
  uid: string;
  assignment: Assignment;
  requestId: string;
  operation: string;
  outcome: "success" | "failure" | "rejected";
  latencyMs?: number;
  httpStatus?: number;
  errorCategory?: string;
}

export interface Telemetry {
  emit(e: EmitInput): void;
  flush(): Promise<void>;
}

export const noopTelemetry: Telemetry = { emit: () => {}, flush: async () => {} };

/** Sends events to the VariantShield ingest API. Server-side only; the ingest key never reaches a browser. */
export function createTelemetry(opts: { url: string; ingestKey: string; experimentId: string | null; featureKey: string; fetch?: typeof fetch; now?: () => number; onError?: (e: unknown) => void }): Telemetry {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const queue: Record<string, unknown>[] = [];
  let timer: NodeJS.Timeout | null = null;
  let inflight: Promise<void> = Promise.resolve();

  const send = (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = null; }
    const batch = queue.splice(0, 500);
    if (batch.length === 0) return inflight;
    inflight = inflight.then(async () => {
      try {
        const res = await doFetch(`${opts.url}/api/ingest`, { method: "POST", headers: { "content-type": "application/json", "x-ingest-key": opts.ingestKey }, body: JSON.stringify({ events: batch }), signal: AbortSignal.timeout(5000) });
        if (!res.ok) opts.onError?.(new Error(`ingest responded ${res.status}`));
      } catch (e) { opts.onError?.(e); }
    });
    return inflight;
  };

  return {
    emit(e) {
      queue.push({
        eventId: randomUUID(), type: e.type, featureKey: opts.featureKey, identityId: e.uid, timestamp: now(), requestId: e.requestId, operation: e.operation, outcome: e.outcome,
        ...(opts.experimentId ? { experimentId: opts.experimentId } : {}),
        // The variant comes only from what Flagsmith served. No assignment means no variantKey.
        ...(e.assignment.source === "flagsmith" && e.assignment.variantKey ? { variantKey: e.assignment.variantKey } : {}),
        ...(e.latencyMs === undefined ? {} : { latencyMs: Math.round(e.latencyMs) }),
        ...(e.httpStatus === undefined ? {} : { httpStatus: e.httpStatus }),
        ...(e.errorCategory ? { errorCategory: e.errorCategory } : {}),
      });
      if (queue.length >= 100) void send();
      else timer ??= setTimeout(() => void send(), 250);
    },
    flush: async () => { while (queue.length) await send(); await inflight; },
  };
}
