# API reference

JSON everywhere. Errors: `{ "error": { "code", "message", "detail?" } }`. Auth schemes: **admin** `Authorization: Bearer $VARIANTSHIELD_ADMIN_TOKEN` (a configured **viewer** token may call `GET` routes except `surface-keys`); **ingest** `X-Ingest-Key` (telemetry); **surface** `X-Surface-Key` (one key per contract and surface); **issuer** `X-Identity-Issuer-Key`. Repeated authentication failures from one client return `429 too_many_auth_failures`. Rate limited per caller (429 with `Retry-After`).

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
| `GET /api/contracts/:id/surface-keys?version=` | admin only | Per-surface reporting keys `{ keys: [{ surfaceId, key }] }`. Secrets. |
| `POST /api/identity/issue` | issuer | `{ subject }` or `{ anonymousId }`, optional `ttlSeconds` (60-3600) and `audience` (a contract id; the token is then only accepted for that contract). Returns `{ subjectRef, token, kind, expiresAt }`. Emails rejected. |
| `POST /api/identity/verify` | ingest or surface | `{ token, audience? }` -> `{ valid, subjectRef?, kind?, expiresAt?, reason? }` (`reason` includes `wrong_audience`). |
| `POST /api/contract-observations` | surface | `{ observations: [...] }` (<= 200). The key is bound to one contract and surface; other values are rejected. Charged per observation against a per-surface quota. `429 observation_quota_exceeded` when the contract is full. See below. |
| `GET /api/contracts/:id/report?version=` | admin (heavy) | Read-only evaluation: status, surfaces, subject matrix (at most 500 subjects, violations first; `subjectsTotal` is the real count), findings, expected and observed combinations, drift. Cached for 5 s, invalidated by any change. |
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
`observedAt` may be at most 60 s ahead of the server clock. `observationId` is unique per contract and surface. `experimentKey`, `assignmentFlag`, the contract version and the surface must match a registered contract version, or the record is rejected. Unknown fields (including anything resembling personal data) are rejected. A missing or invalid token is accepted but stored `unlinked`. The same `observationId` with identical content is a `duplicate`; with different content it is rejected as an idempotency conflict. Real surfaces cannot write to simulation contracts.

## Decision ledger, context and assistant
| Method and path | Auth | Purpose |
|---|---|---|
| `GET /api/ledger?subjectType=&subjectId=&kind=&limit=&before=` | admin or viewer | Entries, newest first |
| `GET /api/ledger/verify` | admin or viewer (heavy) | `{ ok, entries, head, firstBadSeq, reason, signaturesChecked }` |
| `GET /api/ledger/export?subjectType=&subjectId=` | admin or viewer (heavy) | `{ exportedAt, head, entries }`. Unfiltered exports verify offline |
| `POST /api/ledger/notes` | admin | `{ scope: { type, id }, text }` |
| `POST /api/ledger/decisions` | admin | `{ scope, decision: ship\|hold\|pause\|rollback\|extend, rationale }`. Records a proposal with a snapshot of the current facts |
| `POST /api/ledger/decisions/:seq/resolve` | admin | `{ action: approve\|reject, confirmation: "APPROVE <seq>", reason, acknowledgeChanges? }`. `403 self_approval_forbidden`, `409 context_changed` (with `detail.changes`), `409 already_resolved`, `400 confirmation_required` |
| `GET /api/context/plan/:id`, `/api/context/contract/:id` | admin or viewer (heavy) | The context brief |
| `POST /api/assistant/ask` | admin or viewer (heavy) | `{ scope, question (<= 400 chars) }` -> `{ answer: { intent, lines, citations, suggestions, draft }, brief }`. Read-only |

## Operations
| Method and path | Auth | Purpose |
|---|---|---|
| `GET /metrics` | admin or viewer | Prometheus text: request, auth-failure, lockout and rate-limit counters, event-loop delay (p99, max), memory, stored rows. Use `authorization: Bearer` in the scrape config. |
| `GET /api/integration` | admin | How this instance is wired (secrets are reported as set or not, never their values). |

## CLI
`variantshield contract validate|register|check|report`, `variantshield contract surface-keys --contract <id>` (prints secrets), `variantshield env-fingerprint <key>`. Exit codes: 0 ok, 1 invalid or violation, 2 usage/connection/auth, 3 incomplete or no data.

## Incident bisection

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /api/swarm` | admin/viewer | Agents, simulation scenarios, Flagsmith wiring |
| `GET /api/incidents[?source=real\|simulation]` | admin/viewer | Incidents, newest first |
| `GET /api/incidents/:id` | admin/viewer | Full view: suspects with prior/posterior, hypotheses, probes and judgements, envelope, messages, agents |
| `POST /api/incidents/simulate` `{scenario}` | admin | Start a SIMULATION (`interaction`, `single`, `not-flags`); demo mode only |
| `POST /api/incidents/:id/envelope` `{confirmation:"BISECT <id>", reason, canaryPercent?, maxRounds?, maxMinutes?}` | admin | Gate 1 |
| `POST /api/incidents/:id/abort` `{reason}` | admin | Stop and remove the canary |
| `POST /api/incidents/:id/remediation` `{action:"propose", reason}` / `{action:"approve", confirmation:"REMEDIATE <id>", reason}` | admin | Gate 2 (approver must differ from proposer) |
| `POST /api/bisect/signals` `{signals:[{identity, ok, ts?, flags:{name:{enabled, value}}}]}` | `X-Ingest-Key` | Outcomes with the flags each request was served (1 to 1000 per call) |
| `POST /api/flagsmith/webhook` | `X-Flagsmith-Signature` | Flagsmith `FLAG_UPDATED` webhook (404 unless `VARIANTSHIELD_FLAGSMITH_WEBHOOK_SECRET` is set) |
| `GET /api/stream[?incident=id]` | admin/viewer (Bearer) | Server-sent events: `incident`, `message`, `tick` |
