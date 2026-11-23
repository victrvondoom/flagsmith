# Integrating your application

You need two things: take the variant from Flagsmith, and tell VariantShield what happened to that identity.

## 1. Get the real assignment

Use the Flagsmith SDK or identities API and keep the value it returns. Do **not** infer the variant from a URL, user agent or UI. If Flagsmith is unreachable, send the event *without* a variant: VariantShield counts it as unattributed and raises a data-quality flag instead of blaming a variant.

## 2. Send telemetry (server-side)

`POST /api/ingest` with header `X-Ingest-Key`. Up to 500 events per request.

```json
{ "events": [{
  "eventId": "9d1c…",              // your idempotency key; replays are safe
  "type": "payment_failed",         // checkout_started | checkout_completed | payment_failed | duplicate_submit | checkout_latency | http_request
  "experimentId": "7",              // Flagsmith experiment id (or the plan key)
  "featureKey": "checkout_flow",
  "variantKey": "upi_first",        // omit when Flagsmith gave you none
  "identityId": "u_9f2c",           // opaque; no emails or names
  "timestamp": 1800000000000,       // ms or ISO-8601; within the retention window
  "requestId": "req-123", "operation": "checkout.payment_failed",
  "outcome": "failure",             // success | failure | rejected
  "latencyMs": 812, "httpStatus": 200, "errorCategory": "payment_declined"
}]}
```

`checkout_latency` requires `latencyMs`; `http_request` requires `httpStatus`. The response lists each event as `accepted`, `duplicate` or `rejected` with reasons. Reusing an `eventId` for a different payload is rejected as an idempotency conflict.

## 3. Report to Flagsmith as usual

Send `$flag_exposure` (value = variant key) and your conversion event (`checkout_completed`) to Flagsmith's events URL so Flagsmith can compute its own result. VariantShield only reads those results.

A complete reference implementation is `apps/checkout-demo/src/server.ts` and `instrument.ts`.

## 4. Metrics defined

| Guardrail | Numerator / denominator |
|---|---|
| payment failure rate | `payment_failed` / `checkout_started` |
| duplicate submission rate | `duplicate_submit` / `checkout_started` |
| HTTP 5xx rate | `http_request` with status >= 500 / all `http_request` |
| checkout p95 latency | nearest-rank p95 of `checkout_latency.latencyMs` |

Statuses reflect association with a variant, not causation; confounders such as traffic mix and deploys are not controlled.
