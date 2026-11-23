# Flagsmith Integration Research (pre-opening)

Sources: this checkout at `be2bd72` (`openapi.yaml`, `docs/docs/experimentation/*`). Items marked **TO VERIFY** need a live check against official docs/images after network access is available; nothing below is assumed beyond what was read in the repo.

## Verified from the repo

| Capability | Evidence | Use in VariantShield |
|---|---|---|
| List/create/get/update experiments | `openapi.yaml` `list_experiments`, `create_experiment`, `get_experiment` | Trial Board source of truth |
| Start / pause / complete | `…/start/`, `…/pause/`, `…/complete/` (POST, body `ExperimentList`, 200 returns `ExperimentList`) | Human-approved control: pause is a documented operation, not guessed |
| Status enum | `DRAFT, RUNNING, PAUSED, COMPLETED` | Before/after state verification |
| Exposure counts | `GET …/exposures/` (nullable until computed), `POST …/exposures/refresh/` | Sample counts per variant |
| Statistical results | `GET …/results/`, `POST …/results/refresh/` | **Verdict A**, read-only; never recomputed |
| Metrics | `…/experiment-metrics/`, `…/experiments/{id}/metrics/` | Primary metric reference |
| Auth | `tokenAuth` or `Master API Key` | Server-side only |
| Self-hosting | `EXPERIMENTATION_ENABLED=true`; events in Flagsmith Postgres (evaluation only) or own warehouse | Compose target |
| Event ingestion | SDKs send exposure/conversion events to an "events URL" shown on the Warehouse card | Demo app uses official SDK |
| Limits | Remote evaluation only; beta; minimum 50 identities / 5 conversions for results | Reflect in guardrail minimum-sample defaults |

## TO VERIFY before building

- Exact `ExperimentList` request body required by `pause` (the schema is reused for the body; confirm whether an empty object is accepted).
- Response shape of `exposures` and `results` (`Experiment` schema).
- Current `@flagsmith/flagsmith` (≥ 12.4.0) and Node SDK experiment/event methods, and whether Node supports experiments server-side.
- OpenTelemetry feature-flag semantic conventions (attribute names such as `feature_flag.key`, `feature_flag.result.variant`) at the current spec version.
- Whether Feature Health and Release Pipelines already offer metric-based gates (to avoid duplication).
- Existing issues/discussions on Flagsmith/flagsmith for variant-level reliability (duplicate search).

## What VariantShield adds (not native)

Operational guardrails (payment failure rate, duplicate submissions, 5xx rate, p95 latency) correlated per variant, an independent verdict beside Flagsmith's statistical result, and human-approved pause with audit trail. It does not replace Flagsmith's Bayesian engine.
