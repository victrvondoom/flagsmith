import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ingest, parseEvent, RateLimiter, toOtelAttributes, type EventStore, type ParseContext, type StoredRow } from "./index.ts";

const NOW = 1_800_000_000_000;
const ctx: ParseContext = { nowMs: NOW, maxAgeMs: 10 * 86_400_000, maxFutureSkewMs: 300_000, knownVariants: ["control", "upi_first", "one_tap"] };
const valid = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  eventId: "evt-1", type: "checkout_started", experimentId: "exp-7", featureKey: "checkout_flow", variantKey: "upi_first",
  identityId: "u_9f2c", timestamp: NOW - 1000, requestId: "req-1", operation: "checkout.start", outcome: "success", ...over,
});
class MemStore implements EventStore {
  rows = new Map<string, StoredRow>();
  insertIfAbsent(row: StoredRow): "inserted" | { existingHash: string } {
    const hit = this.rows.get(row.event.eventId);
    if (hit) return { existingHash: hit.payloadHash };
    this.rows.set(row.event.eventId, row);
    return "inserted";
  }
}

describe("telemetry validation", () => {
  it("parseEvent__valid_event__is_attributed", () => {
    const r = parseEvent(valid(), ctx);
    assert.ok(r.ok);
    assert.equal(r.event.attribution, "valid");
    assert.equal(r.event.source, "real");
  });

  it("parseEvent__missing_variant__is_flagged_missing_not_defaulted", () => {
    const r = parseEvent(valid({ variantKey: undefined }), ctx);
    assert.ok(r.ok);
    assert.equal(r.event.variantKey, null);
    assert.equal(r.event.attribution, "missing");
  });

  it("parseEvent__variant_not_in_experiment__is_flagged_unknown", () => {
    const r = parseEvent(valid({ variantKey: "blue_button" }), ctx);
    assert.ok(r.ok);
    assert.equal(r.event.attribution, "unknown_variant");
  });

  it("parseEvent__email_as_identity__is_rejected", () => {
    const r = parseEvent(valid({ identityId: "jane@example.com" }), ctx);
    assert.ok(!r.ok);
    assert.ok(r.issues.some((i) => i.field === "identityId"));
  });

  it("parseEvent__pii_field__is_rejected", () => {
    const r = parseEvent(valid({ email: "a@b.co", userAgent: "x" }), ctx);
    assert.ok(!r.ok);
    assert.equal(r.issues.filter((i) => /personal data/.test(i.message)).length, 2);
  });

  it("parseEvent__bad_timestamps__are_rejected", () => {
    for (const timestamp of [NOW + 3_600_000, NOW - 11 * 86_400_000, 12, "yesterday", 1.5]) {
      assert.ok(!parseEvent(valid({ timestamp }), ctx).ok, String(timestamp));
    }
    assert.ok(parseEvent(valid({ timestamp: new Date(NOW - 5000).toISOString() }), ctx).ok);
  });

  it("parseEvent__type_specific_requirements__are_enforced", () => {
    assert.ok(!parseEvent(valid({ type: "checkout_latency" }), ctx).ok);
    assert.ok(!parseEvent(valid({ type: "http_request" }), ctx).ok);
    assert.ok(!parseEvent(valid({ type: "http_request", httpStatus: 99 }), ctx).ok);
    assert.ok(parseEvent(valid({ type: "http_request", httpStatus: 503 }), ctx).ok);
    assert.ok(!parseEvent(valid({ type: "checkout_latency", latencyMs: -1 }), ctx).ok);
  });

  it("parseEvent__non_object__is_rejected", () => {
    for (const bad of [null, 5, "x", []]) assert.ok(!parseEvent(bad, ctx).ok);
  });
});

describe("telemetry ingest", () => {
  it("ingest__replayed_event__is_duplicate_and_stored_once", () => {
    const store = new MemStore();
    const first = ingest([valid()], store, ctx);
    const second = ingest([valid()], store, ctx);
    assert.equal(first.accepted, 1);
    assert.equal(second.duplicate, 1);
    assert.equal(store.rows.size, 1);
  });

  it("ingest__same_id_different_payload__is_idempotency_conflict", () => {
    const store = new MemStore();
    ingest([valid()], store, ctx);
    const r = ingest([valid({ outcome: "failure" })], store, ctx);
    assert.equal(r.rejected, 1);
    assert.match(r.results[0]!.issues![0]!.message, /idempotency conflict/);
  });

  it("ingest__mixed_batch__reports_per_item_status", () => {
    const store = new MemStore();
    const r = ingest([valid(), valid({ eventId: "evt-2", variantKey: undefined }), { nonsense: true }], store, ctx);
    assert.deepEqual([r.accepted, r.rejected, r.unattributed], [2, 1, 1]);
    assert.equal(r.results[2]!.status, "rejected");
  });

  it("ingest__empty_or_oversized_batch__throws", () => {
    assert.throws(() => ingest([], new MemStore(), ctx), RangeError);
    assert.throws(() => ingest(new Array(501).fill(valid()), new MemStore(), ctx), RangeError);
    assert.throws(() => ingest("x", new MemStore(), ctx), RangeError);
  });
});

describe("rate limiter and otel mapping", () => {
  it("take__burst_beyond_capacity__is_limited_then_refills", () => {
    const l = new RateLimiter({ capacity: 2, refillPerSecond: 1 });
    assert.equal(l.take("k", 0), 0);
    assert.equal(l.take("k", 0), 0);
    assert.ok(l.take("k", 0) > 0);
    assert.equal(l.take("k", 1500), 0);
    assert.equal(l.take("other", 0), 0, "buckets are per key");
  });

  it("toOtelAttributes__valid_event__uses_semconv_names", () => {
    const r = parseEvent(valid({ type: "payment_failed", outcome: "failure", errorCategory: "card_declined" }), ctx);
    assert.ok(r.ok);
    const a = toOtelAttributes(r.event);
    assert.equal(a["feature_flag.key"], "checkout_flow");
    assert.equal(a["feature_flag.result.variant"], "upi_first");
    assert.equal(a["error.type"], "card_declined");
  });

  it("toOtelAttributes__unattributed_event__omits_variant", () => {
    const r = parseEvent(valid({ variantKey: "blue_button" }), ctx);
    assert.ok(r.ok);
    assert.equal("feature_flag.result.variant" in toOtelAttributes(r.event), false);
  });
});
