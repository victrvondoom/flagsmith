import { createHash } from "node:crypto";
import { parseEvent } from "./schema.ts";
import type { EventStore, IngestItemResult, ParseContext, TelemetryEvent } from "./types.ts";

export const MAX_BATCH = 500;

export function hashEvent(e: TelemetryEvent): string {
  return createHash("sha256").update(JSON.stringify(e)).digest("hex");
}

export interface IngestSummary {
  accepted: number;
  duplicate: number;
  rejected: number;
  unattributed: number;
  results: IngestItemResult[];
}

/**
 * Validates and stores a batch. Idempotent: replaying an eventId with an identical payload
 * is reported as a duplicate; reusing an eventId for a different payload is rejected.
 */
export function ingest(batch: unknown, store: EventStore, ctx: ParseContext): IngestSummary {
  if (!Array.isArray(batch)) throw new RangeError("events must be an array");
  if (batch.length === 0) throw new RangeError("events must be non-empty");
  if (batch.length > MAX_BATCH) throw new RangeError(`at most ${MAX_BATCH} events per batch`);

  const summary: IngestSummary = { accepted: 0, duplicate: 0, rejected: 0, unattributed: 0, results: [] };
  batch.forEach((item, index) => {
    const parsed = parseEvent(item, ctx);
    if (!parsed.ok) {
      summary.rejected++;
      const id = typeof (item as { eventId?: unknown } | null)?.eventId === "string" ? (item as { eventId: string }).eventId : null;
      summary.results.push({ index, eventId: id, status: "rejected", issues: parsed.issues });
      return;
    }
    const e = parsed.event;
    const hash = hashEvent(e);
    const outcome = store.insertIfAbsent({ event: e, payloadHash: hash });
    if (outcome === "inserted") {
      summary.accepted++;
      if (e.attribution !== "valid") summary.unattributed++;
      summary.results.push({ index, eventId: e.eventId, status: "accepted", attribution: e.attribution });
    } else if (outcome.existingHash === hash) {
      summary.duplicate++;
      summary.results.push({ index, eventId: e.eventId, status: "duplicate", attribution: e.attribution });
    } else {
      summary.rejected++;
      summary.results.push({
        index, eventId: e.eventId, status: "rejected",
        issues: [{ field: "eventId", message: "already used for a different payload (idempotency conflict)" }],
      });
    }
  });
  return summary;
}
