export const EVENT_TYPES = [
  "checkout_started",
  "checkout_completed",
  "payment_failed",
  "duplicate_submit",
  "checkout_latency",
  "http_request",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const OUTCOMES = ["success", "failure", "rejected"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export type DataSource = "real" | "simulation";
export type Attribution = "valid" | "missing" | "unknown_variant";

/** A validated, normalised telemetry event. */
export interface TelemetryEvent {
  /** Idempotency key chosen by the producer. */
  eventId: string;
  type: EventType;
  experimentId: string | null;
  featureKey: string;
  /** Variant key exactly as Flagsmith assigned it; null when no assignment was captured. */
  variantKey: string | null;
  /** Opaque application identity (never an email or name). */
  identityId: string;
  timestampMs: number;
  requestId: string;
  operation: string;
  outcome: Outcome;
  latencyMs: number | null;
  errorCategory: string | null;
  httpStatus: number | null;
  source: DataSource;
  /** Whether `variantKey` may be used for attribution. */
  attribution: Attribution;
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export type ParseResult = { ok: true; event: TelemetryEvent } | { ok: false; issues: ValidationIssue[] };

export interface ParseContext {
  nowMs: number;
  /** Variants that exist for the experiment; when given, others are flagged unknown_variant. */
  knownVariants?: readonly string[];
  maxAgeMs: number;
  maxFutureSkewMs: number;
}

export type IngestStatus = "accepted" | "duplicate" | "rejected";

export interface IngestItemResult {
  index: number;
  eventId: string | null;
  status: IngestStatus;
  attribution?: Attribution;
  issues?: ValidationIssue[];
}

export interface StoredRow {
  event: TelemetryEvent;
  payloadHash: string;
}

/** Persistence boundary; the API provides a SQLite implementation. */
export interface EventStore {
  /** Returns "inserted", or the stored payload hash when eventId already exists. */
  insertIfAbsent(row: StoredRow): "inserted" | { existingHash: string };
}
