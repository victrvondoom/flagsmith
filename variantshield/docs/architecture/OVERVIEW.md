# Architecture

```mermaid
flowchart LR
  subgraph App["Your application"]
    SDK["Flagsmith SDK / identities API"]
    INS["Variant-aware instrumentation"]
  end
  FS[("Self-hosted Flagsmith<br/>(experiments, flags, events)")]
  subgraph VS["VariantShield"]
    API["API: ingest, verdicts, control<br/>node:http + SQLite"]
    ENG["Guardrail engine (pure)"]
    VER["Dual verdict (pure)"]
    ADP["Flagsmith adapter"]
    UI["Dashboard (static, CSP-strict)"]
    BENCH["Variant Bench (Playwright)"]
  end
  SDK -- "assigned variant" --> FS
  SDK --> INS
  INS -- "telemetry (ingest key)" --> API
  INS -- "exposure + conversion events" --> FS
  API --> ENG --> VER
  API <--> ADP <-- "Management API (server-side credential)" --> FS
  UI -- "admin token" --> API
  API -- "spawns" --> BENCH
  VER -- "Verdict A: Flagsmith results (read only)" --- FS
```

## Modules (`variantshield/`)

| Path | Responsibility | Depends on |
|---|---|---|
| `packages/flagsmith-adapter` | Typed Flagsmith client: experiments, results, exposures, identities, events, lifecycle. Retry (reads only), timeouts, typed errors, response validation. | Node `fetch` |
| `packages/telemetry` | Event schema + validation, PII rejection, idempotent ingest, token-bucket limiter, OTel attribute mapping. | none |
| `packages/guardrail-engine` | Pure, deterministic evaluation of four guardrails per variant against a baseline; recovery logic; seeded fixtures for simulation. | none |
| `packages/verdict` | Combines Flagsmith's result with the guardrail report into one of five outcomes with evidence. | engine |
| `apps/api` | HTTP API, SQLite persistence and migrations, auth, rate limits, board derivation, control flow, audit, bench runner, simulation. | all packages |
| `apps/dashboard` | Six screens, vanilla JS, no build. | API only |
| `apps/checkout-demo` | Three checkout variants, instrumentation, fault injection. | adapter |
| `apps/variant-bench` | Nine-test Playwright acceptance suite run per variant. | demo |

Dependency direction is one way: packages never import apps; the dashboard only talks HTTP.

## Guardrail statuses

`INSUFFICIENT_DATA` · `HEALTHY` · `WARNING` · `BREACH` · `RECOVERING`. Severity: BREACH > WARNING > RECOVERING > INSUFFICIENT_DATA > HEALTHY. A variant is `HEALTHY` only if every metric has sufficient samples. Rate metrics are compared to the baseline variant by absolute difference; `BREACH` additionally needs the Newcombe/Wilson lower bound of the difference to exceed zero (otherwise `WARNING`). Latency compares nearest-rank p95 as a ratio. `RECOVERING` means the current window is clean but fewer than `recoveryWindows` consecutive clean windows have passed since a breach or warning.

```mermaid
stateDiagram-v2
  [*] --> INSUFFICIENT_DATA
  INSUFFICIENT_DATA --> HEALTHY: enough samples, within thresholds
  HEALTHY --> WARNING: delta >= warn
  WARNING --> BREACH: delta >= breach and CI excludes 0
  HEALTHY --> BREACH: delta >= breach and CI excludes 0
  BREACH --> RECOVERING: window clean
  WARNING --> RECOVERING: window clean
  RECOVERING --> HEALTHY: recoveryWindows consecutive clean
  RECOVERING --> BREACH: relapse
```

## Dual verdict outcomes

`WINNER_AND_SAFE`, `WINNER_BUT_UNSAFE`, `HEALTHY_BUT_INCONCLUSIVE`, `INSUFFICIENT_EVIDENCE`, `REQUIRES_INVESTIGATION`. A conversion winner is never promoted by itself; a breach on a running experiment recommends `pause`, and every control action still needs a human.

## Board state (derived, never edited)

`PLANNED` (no Flagsmith link) → `CONFIGURED` / `QUALIFYING` (Flagsmith `created`; qualifying while a bench run is running or has failures) → `RUNNING` / `WARNING` / `BREACH` (Flagsmith `running` + guardrail result) → `PAUSED` → `COMPLETED`. If Flagsmith is unreachable the card shows the last known status marked **stale**; VariantShield never claims "running" without a fresh Flagsmith answer.

## Control flow

```mermaid
sequenceDiagram
  actor H as Human
  participant D as Dashboard
  participant A as API
  participant F as Flagsmith
  H->>D: Dry run
  D->>A: POST /api/control {dryRun:true}
  A->>F: GET experiment (before)
  A-->>D: would call POST .../pause/, running -> paused (audited)
  H->>D: Review, type "PAUSE 7", reason
  D->>A: POST /api/control {dryRun:false, confirmation, reason}
  A->>F: GET before, POST pause (no retry), GET after
  A-->>D: running -> paused (verified) or verification_failed (audited)
```

## Data model (SQLite, versioned migrations)

`plans`, `events` (idempotency key = `event_id`, payload hash for conflict detection, `source` real|simulation, `attribution` valid|missing|unknown_variant), `bench_runs`/`bench_results`, `evidence`, `audit`, `schema_migrations`. Events are purged after `RETENTION_DAYS`.

## Cross-surface contracts (Phase 2)

```
 identity issuer (trusted backend) --> subjectRef + vsid1 token
        |
 surfaces: web | mobile | payment-api | risk-engine
   each: verify token -> ask Flagsmith for the variant of subjectRef -> resolve own features -> report observation
        |
 POST /api/contract-observations  (ingest key, token verified, deduped)
        |
 contracts store (immutable versions) + observations
        |
 evaluateContract (pure) --> findings, status      configDrift / observationDrift / silentSurfaces --> drift history
        |
 dashboard #/contracts, CLI `variantshield contract ...`, POST /api/contracts/:id/check (re-verifies with Flagsmith)
```

Package `packages/contracts` is pure (no I/O): manifest parsing, combination validation, identity primitives, correlation, drift. `apps/api/src/contracts.ts` adds persistence and the Flagsmith re-verification.

Tables added by migration 2: `contracts` (id, version, normalized JSON, immutable), `contract_observations` (identity_status verified|unlinked), `contract_findings` (dedupe key, kept as history), `contract_drift`, `assignment_config_snapshots`. The simulation contract id is `sim-checkout-journey`; real surfaces cannot write to it. Details: [`docs/guides/CONTRACTS.md`](../guides/CONTRACTS.md).
