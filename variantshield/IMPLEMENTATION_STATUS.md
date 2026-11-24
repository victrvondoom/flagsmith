# Implementation status

Branch: `vsrupeshkumar/zealous-newton-5mhe7m` (PR #1). Everything below lives in the existing VariantShield project.

## Phase 1: reliability guardrails (done, committed)
Flagsmith adapter, telemetry, guardrail engine, dual verdict, API, dashboard, checkout demo, Playwright bench, human-approved pause, 112 tests, real-Flagsmith verification. See README "Verification status".

## Phase 2: cross-surface experiment contracts (this change)

Checklist (inspected existing code first: adapter `packages/flagsmith-adapter`, telemetry `packages/telemetry`, SQLite migrations in `apps/api/src/db.ts`, routes in `apps/api/src/app.ts`, dashboard `apps/dashboard/public/views.js`, tests under `node:test` + Playwright):

- [x] `packages/contracts`: manifest parse/validate (YAML+JSON), combination validator, canonical identity (HMAC tokens), correlation, drift
- [x] Adapter: `getAssignmentConfig` (config fingerprint); endpoints checked against Flagsmith source and a live instance, drift on weight change tested with a fake only
- [x] DB migration 2: contracts (versioned, immutable), observations, findings, drift, config snapshots
- [x] API: validate/register/list/versions, observation ingest (identity verified, deduped), check, report, findings, drift, identity issue/verify, simulation scenarios
- [x] Four sample surfaces + live driver using real Flagsmith assignment
- [x] CLI `variantshield contract validate|check|report`
- [x] Dashboard: Overview, Surface matrix, Combination matrix, Drift, Evidence
- [x] Reliability timelines in the Observatory
- [x] Tests: unit, API integration, CLI, Playwright
- [x] Docs: README, architecture, API reference, contract schema, example contract

Genuine outcomes are recorded in the "Log" below as work proceeds.

## Log

- Full `npm run check` (tsc strict, eslint, all tests): 221 tests, 0 failures, exit 0.
- Live contract demo against a real Flagsmith (built from source) passed before a sandbox restart: healthy, combination violation, stale-variant assignment mismatch. Not re-run after restart.
- Not verified: Docker/compose (no daemon), Flagsmith Cloud, live config-fingerprint drift, live environment mismatch.
- Integration page (`#/integration`, `GET /api/integration`) added: shows Flagsmith connection health and which secrets are set, never values. `npm run check`: 222 tests, 0 failures.

## Hardening pass (security audit follow-up)
Each item was measured or reproduced first, then fixed with a regression test (`apps/api/src/security.api.test.ts`, 26 tests).

| Finding | Fix |
|---|---|
| 500 wrong admin tokens never throttled (measured) | Failed auth throttled per client before comparison; production rejects weak secrets |
| 60,000 forged observations stored in 1.8 s (measured); only `events` were purged | Per-observation quota, per-contract storage cap, retention for every table |
| Any ingest-key holder could report as any surface | Per-surface keys bound to (contract, surface); master key cannot write observations; compose no longer passes the whole `.env` to surfaces |
| `/report` stalled the event loop ~1.3 s on 60k rows (measured) | Two quadratic loops removed (1.9 s to 0.23 s on 20k rows), 5 s cache with invalidation, heavy-route rate limit, response capped at 500 subjects, Flagsmith re-verification capped at 50 lookups or 8 s |
| Identity secret rotation would re-bucket every customer | Pseudonym key separate from the rotatable token key (with `_PREVIOUS`); tokens carry `jti` and an optional contract `audience` |
| Shared rate-limit bucket behind a proxy | `VARIANTSHIELD_TRUST_PROXY` uses the last `X-Forwarded-For` hop |
| `observationId` squatting; far-future `observedAt` | ids namespaced per contract and surface; future skew limit 60 s |
| No read-only role, no metrics | Optional viewer token; `/metrics` (Prometheus) |
| Incomplete headers, no slow-client limits | CSP `base-uri/form-action/object-src`, Permissions-Policy, COOP/CORP, HSTS behind HTTPS proxy; header, request and connection limits |
| Compose and CI gaps | Hardened compose (read-only, no capabilities, limits, health checks); CI adds `npm audit`, compose validation, an image build and run check; CodeQL; Dependabot |

Follow-up found by re-checking my own work:
* The quota check ran `COUNT(*)` over up to 500k rows on every ingest request (23 ms each, measured), which let a key holder saturate the event loop at the rate limit. It is now an in-memory count refreshed every 30 s.
* One lockout bucket for all credential types let failed surface keys lock the admin out. Buckets are now per credential class.
* `scripts/contract-demo.ts` failed with a 409 when the contract had already been registered with the CLI (the only order that works with per-surface keys). Fixed; the full demo was re-run end to end.
* Demo cookies: `Secure` was added after a CodeQL finding; verified in Chromium only.

Verification: `npm run check` passes; CI on the head commit: `check`, `docker` and CodeQL `analyze` succeeded.

Not done (needs design work or a real environment): moving off SQLite, a durable ingest queue, per-user SSO and audit identity, alerting/webhooks, an observation SDK, anonymous to authenticated linking, pinning GitHub Actions and the base image by digest (digests cannot be verified offline), and bringing the compose stack up end to end.

## Decision memory, rule-based assistant, MCP, upstream draft
Requested as one use-case tool with a genuine workflow. Built:

* **Ledger** (`apps/api/src/ledger.ts`, migration 3): append-only (triggers), hash-chained, HMAC-signed; automatic capture from plan approval, evidence, executed control actions, contract registration and status change; propose, approve and reject with a second-actor rule, typed confirmation, reason and stale-context acknowledgement. 33 API tests including tamper detection (edited entry, removed entry, forged signature) and key rotation.
* **Context brief** (`briefing.ts`): one deterministic digest per plan or contract, with a fingerprint of the facts a decision depends on and a diff against the last official decision. A plan includes the contracts that check the same flag.
* **Assistant** (`assistant.ts`): rule-based, cited, drafts only. Defaults to hold when the ledger fails verification or a contract is violated.
* **MCP server** (`apps/mcp`): stdio JSON-RPC, six tools, read-only by default, output marked as data and sanitised; 11 tests including a real stdio session.
* **Dashboard** (`#/ledger`), **CLI** (`ledger verify|export`, offline verification with `--expect-head`), docs, and an unposted upstream discussion draft.

What "official" means: approved by a second named actor in this ledger. It is not an official Flagsmith product, and the upstream draft says so.

Limits: the actor is a caller-supplied name; newest-entry truncation needs an externally stored head; the assistant is pattern-based and answers only the listed intents; MCP prompt-injection risk is reduced, not removed. Not tested with a real MCP client (the tests speak the protocol directly); not tested in Firefox or WebKit.

Verification: `npm run check` passes, 295 tests, 0 failures.
