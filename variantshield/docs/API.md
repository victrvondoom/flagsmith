# API reference

JSON everywhere. Errors: `{ "error": { "code", "message", "detail?" } }`. Auth schemes: **admin** `Authorization: Bearer $VARIANTSHIELD_ADMIN_TOKEN`; **ingest** `X-Ingest-Key`; **issuer** `X-Identity-Issuer-Key`. Rate limited per caller (429 with `Retry-After`).

## Public
`GET /health`, `GET /ready`, `GET /api/public-config`.

## Reliability guardrails
| Method and path | Auth | Purpose |
|---|---|---|
| `POST /api/ingest` | ingest | Batch of telemetry events (<= 500); idempotent by `eventId`. |
| `GET /api/overview`, `GET /api/board` | admin | Command Center and Trial Board data. |
| `GET/POST /api/plans`, `GET/PATCH/DELETE /api/plans/:id` | admin | Experiment plans. |
| `POST /api/plans/:id/link`, `/unlink`, `/approval`, `/evidence` | admin | Link to Flagsmith, record approval, snapshot evidence. |
| `POST /api/plans/import-flagsmith` | admin | Import Flagsmith experiments as plans. |
| `GET /api/plans/:id/reliability`, `/timeline`, `/verdict` | admin | Guardrail report, bucketed timelines with threshold lines, dual verdict. `?source=real|simulation`. |
| `GET /api/control/:id/status`, `POST /api/control` | admin | Human-approved pause/resume/complete (dry run, typed confirmation, audit, state verification). |
| `GET /api/audit`, `GET /api/events/summary` | admin | Audit trail, telemetry summary. |
| `GET/POST /api/bench/runs`, `GET /api/bench/runs/:id[/screenshots/:file]` | admin | Playwright bench. |
| `GET /api/simulate/scenarios`, `POST /api/simulate/:id` | admin | Reliability simulations. |

## Cross-surface contracts
| Method and path | Auth | Purpose |
|---|---|---|
| `POST /api/contracts/validate` | admin | Body: manifest object or `{ "yaml": "..." }`. Returns `{ valid, issues[], contract }`. |
| `POST /api/contracts` | admin | Register a version. `201`-style `{ status: "created"\|"unchanged", contract, drift[], warnings[] }`. `409 contract_version_immutable` if the version exists with different content, `409 version_not_increasing`. |
| `GET /api/contracts`, `GET /api/contracts/:id`, `GET /api/contracts/:id/versions/:v` | admin | List, latest plus versions, a specific immutable version. |
| `POST /api/identity/issue` | issuer | `{ subject }` or `{ anonymousId }`, optional `ttlSeconds` (60-3600). Returns `{ subjectRef, token, kind, expiresAt }`. Emails rejected. |
| `POST /api/identity/verify` | ingest | `{ token }` -> `{ valid, subjectRef?, kind?, expiresAt?, reason? }`. |
| `POST /api/contract-observations` | ingest | `{ observations: [...] }` (<= 200). See below. |
| `GET /api/contracts/:id/report?version=` | admin | Read-only evaluation: status, surfaces, subject matrix, findings, expected and observed combinations, drift. |
| `POST /api/contracts/:id/check?version=` | admin | Re-verify with Flagsmith, record config drift, persist findings; returns the report plus `persisted` and `flagsmith` info. |
| `GET /api/contracts/:id/findings?version=&code=`, `GET /api/contracts/:id/drift` | admin | Historical findings and drift (never discarded). |
| `GET /api/contract-example`, `GET /api/contract-scenarios`, `POST /api/simulate/contract/:scenario` | admin | Example manifest, scenario list, run a labelled simulation. |

### Observation
```json
{
  "observationId": "web-checkout-5f2c…",      "contractId": "checkout-journey",     "contractVersion": 1,
  "experimentKey": "checkout_journey",         "assignmentFlag": "checkout_journey_variant",
  "environment": "production",                 "envFingerprint": "0123456789abcdef",
  "surfaceId": "web-checkout",                 "assignedVariant": "upi_first",
  "identityToken": "vsid1.…",                  "observedAt": 1800000000000,
  "features": { "checkout_ui": "upi_first" }
}
```
`experimentKey`, `assignmentFlag`, the contract version and the surface must match a registered contract version, or the record is rejected. Unknown fields (including anything resembling personal data) are rejected. A missing or invalid token is accepted but stored `unlinked`. The same `observationId` with identical content is a `duplicate`; with different content it is rejected as an idempotency conflict. Real surfaces cannot write to simulation contracts.

## CLI
`variantshield contract validate|register|check|report`, `variantshield env-fingerprint <key>`. Exit codes: 0 ok, 1 invalid or violation, 2 usage/connection/auth, 3 incomplete or no data.
