import { EVENT_TYPES, OUTCOMES, type ParseContext, type ParseResult, type TelemetryEvent, type ValidationIssue } from "./types.ts";

const MIN_TIMESTAMP_MS = 1_577_836_800_000; // 2020-01-01T00:00:00Z
const ID_RE = /^[A-Za-z0-9_\-:.]{1,128}$/;
const KEY_RE = /^[A-Za-z0-9_\-:. /]{1,256}$/;
const CATEGORY_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Field names that signal personal data; rejected outright rather than silently dropped. */
const PII_FIELDS = new Set(["email", "name", "fullname", "phone", "ip", "ipaddress", "useragent", "user_agent", "address", "cardnumber", "card", "pan"]);

const KNOWN_FIELDS = new Set([
  "eventId", "type", "experimentId", "featureKey", "variantKey", "identityId", "timestamp",
  "requestId", "operation", "outcome", "latencyMs", "errorCategory", "httpStatus", "source",
]);

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

export function parseEvent(input: unknown, ctx: ParseContext): ParseResult {
  const issues: ValidationIssue[] = [];
  const bad = (field: string, message: string): void => void issues.push({ field, message });
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, issues: [{ field: "$", message: "event must be a JSON object" }] };
  }
  const raw = input as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (PII_FIELDS.has(key.toLowerCase())) bad(key, "personal data must not be sent; use an opaque identityId");
    else if (!KNOWN_FIELDS.has(key)) bad(key, "unknown field");
  }

  const str = (field: string, re: RegExp, required = true): string | null => {
    const v = raw[field];
    if (v === undefined || v === null || v === "") {
      if (required) bad(field, "is required");
      return null;
    }
    if (typeof v !== "string" || !re.test(v)) {
      bad(field, "has an invalid format");
      return null;
    }
    return v;
  };

  const eventId = str("eventId", ID_RE);
  const featureKey = str("featureKey", KEY_RE);
  const identityId = str("identityId", ID_RE);
  const requestId = str("requestId", ID_RE);
  const operation = str("operation", ID_RE);
  const experimentId = str("experimentId", ID_RE, false);
  const variantKeyRaw = str("variantKey", KEY_RE, false);

  const type = raw.type;
  if (typeof type !== "string" || !(EVENT_TYPES as readonly string[]).includes(type)) bad("type", `must be one of ${EVENT_TYPES.join(", ")}`);
  const outcome = raw.outcome;
  if (typeof outcome !== "string" || !(OUTCOMES as readonly string[]).includes(outcome)) bad("outcome", `must be one of ${OUTCOMES.join(", ")}`);

  const ts = parseTimestamp(raw.timestamp);
  if (ts === null) bad("timestamp", "must be epoch milliseconds or an ISO-8601 string");
  else if (ts < MIN_TIMESTAMP_MS) bad("timestamp", "must be after 2020-01-01");
  else if (ts > ctx.nowMs + ctx.maxFutureSkewMs) bad("timestamp", "is too far in the future");
  else if (ts < ctx.nowMs - ctx.maxAgeMs) bad("timestamp", "is older than the retention window");

  let latencyMs: number | null = null;
  if (raw.latencyMs !== undefined && raw.latencyMs !== null) {
    if (typeof raw.latencyMs !== "number" || !Number.isFinite(raw.latencyMs) || raw.latencyMs < 0 || raw.latencyMs > 600_000) bad("latencyMs", "must be a number between 0 and 600000");
    else latencyMs = raw.latencyMs;
  } else if (type === "checkout_latency") bad("latencyMs", "is required for checkout_latency");

  let httpStatus: number | null = null;
  if (raw.httpStatus !== undefined && raw.httpStatus !== null) {
    if (typeof raw.httpStatus !== "number" || !Number.isInteger(raw.httpStatus) || raw.httpStatus < 100 || raw.httpStatus > 599) bad("httpStatus", "must be an integer between 100 and 599");
    else httpStatus = raw.httpStatus;
  } else if (type === "http_request") bad("httpStatus", "is required for http_request");

  const errorCategory = str("errorCategory", CATEGORY_RE, false);
  const source = raw.source ?? "real";
  if (source !== "real" && source !== "simulation") bad("source", 'must be "real" or "simulation"');

  if (issues.length > 0) return { ok: false, issues };

  let attribution: TelemetryEvent["attribution"] = "valid";
  let variantKey = variantKeyRaw;
  if (variantKey === null) attribution = "missing";
  else if (ctx.knownVariants && !ctx.knownVariants.includes(variantKey)) attribution = "unknown_variant";
  if (attribution !== "valid") variantKey = attribution === "missing" ? null : variantKey;

  return {
    ok: true,
    event: {
      eventId: eventId!, type: type as TelemetryEvent["type"], experimentId, featureKey: featureKey!, variantKey,
      identityId: identityId!, timestampMs: ts!, requestId: requestId!, operation: operation!,
      outcome: outcome as TelemetryEvent["outcome"], latencyMs, errorCategory, httpStatus,
      source: source as TelemetryEvent["source"], attribution,
    },
  };
}
