# Flagsmith integration research

Everything here was read from this repository's own source at the time of writing (`openapi.yaml`, `api/experimentation/*.py`, `docs/docs/experimentation/*`) and then **verified against a real Flagsmith API server** built from that source (see "Live verification"). Items I could not verify are marked.

## Experiment API used by VariantShield

| Operation | Endpoint (under `/api/v1/environments/{environment_api_key}/`) | Notes |
|---|---|---|
| List / get experiments | `GET experiments/`, `GET experiments/{id}/` | Paginated list (`results`, `next`). `feature` is an object including `name` and `multivariate_options`. |
| Start / pause / complete | `POST experiments/{id}/start/`, `/pause/`, `/complete/` | Body `{}`. Returns the experiment. Invalid transition returns 400 `Unable to transition experiment status.` |
| Exposures | `GET experiments/{id}/exposures/` | `{ "exposures": null \| { as_of, is_final, payload } }`. Payload: `{ excluded_identities, timeseries: { granularity, points: [{ bucket, new_identities: { variant: n } }] } }`. |
| Results | `GET experiments/{id}/results/` | `{ "results": null \| { as_of, is_final, last_error_at, payload } }`. Payload is Flagsmith's `ResultsSummary`: `metrics[]{ metric_id, variants{ variant: { n, sum, sum_squares } }, inference{ variant: { lift, ci_low, ci_high, chance_to_win } \| null }, conversions_timeseries }`, `srm_p_value`, `exposures_timeseries`. |
| Refresh | `POST experiments/{id}/results/refresh/`, `/exposures/refresh/` | 202. Throttled to one per 5 minutes (429 with a wait hint). |
| Assignments (SDK) | `GET /api/v1/identities/?identifier=` with `X-Environment-Key` | Served value of the multivariate flag is `feature_state_value`. |
| Events (SDK) | `POST /api/v1/events/` with `X-Environment-Key` | Body `{ events: [{ event, identifier, timestamp (ms), feature_name?, value? }] }`. Exposure event name `$flag_exposure`, `value` = variant key. Rejected if older than 10 days or more than 24 h ahead. |

## Corrections to what the OpenAPI file suggests

* **Status values are lowercase: `created`, `running`, `paused`, `completed`.** (`openapi.yaml` `Status7a8Enum`; a filter description in the same file says `DRAFT, RUNNING, ...`, which is wrong.)
* **Valid transitions** (`api/experimentation/models.py` `VALID_STATUS_TRANSITIONS`): created→running; running→paused|completed; paused→running|completed; completed→none. Resume is `start`.
* **The served results payload is not the `ExperimentResults` schema** (`winner`, `significant`, `p_value`) shown in `openapi.yaml`. Flagsmith is Bayesian and serves per-variant `chance_to_win`/credible intervals. VariantShield therefore *reads* those numbers and derives "winner" with a visible rule (see below). It never recomputes statistics.
* Auth for the Management API is `Authorization: Api-Key <key>` (master API key) or `Authorization: Token <token>`. The `Token` form was exercised live.
* A "Flagsmith database" warehouse is a connection of type `postgres` with `config {"source": "flagsmith_database"}` (the `flagsmith` type is for Flagsmith Cloud's managed store). Without it `POST /api/v1/events/` returns 404 `This environment does not store events in Flagsmith.`

## Winner rule (Verdict A)

A treatment is reported as winner only when, on the first metric: every variant has at least **50 identities and 5 conversions** (Flagsmith's own floors, `experimentation/constants.py`), Flagsmith's `chance_to_win` is at least **0.95** (configurable) and the credible interval's lower bound is above zero. Anything else is "inconclusive" with Flagsmith's own warning shown. This is a presentation threshold over Flagsmith's numbers, not a new statistic.

## OpenTelemetry attributes

Verified at <https://opentelemetry.io/docs/specs/semconv/registry/attributes/feature-flag/> (release candidate): `feature_flag.key`, `feature_flag.result.variant`, `feature_flag.result.value`; `feature_flag.variant` is deprecated. VariantShield emits `feature_flag.key` and `feature_flag.result.variant` (only when the assignment is valid), plus `error.type` and `http.response.status_code` where applicable. Everything else is namespaced `variantshield.*`.

## Live verification (real Flagsmith, built from this repo's source)

A real Flagsmith API (Django, PostgreSQL 16, `EXPERIMENTATION_ENABLED=true`) was run locally and driven only through its REST API. `scripts/verify-flagsmith.ts --lifecycle --events 400` and `scripts/live-demo.ts` then confirmed:

* Management API reads with `Token` auth; experiment list/get parsing, including variant options.
* The identities endpoint serves all three variants (`control`, `upi_first`, `one_tap`).
* Exposure and conversion events are accepted once the Flagsmith-database connection exists.
* Real `ResultsSummary` and exposures payloads parse. With 6000 synthetic identities Flagsmith reported `upi_first` at 99.96% chance to win (+17.5% lift); with the earlier ~380 identities it correctly reported *no* winner.
* `start`, `pause`, `resume` and the 429 refresh throttle behave as documented, and the adapter re-reads state after every mutation.

Not verified: Flagsmith Cloud, the ClickHouse/Databricks warehouse paths, local (server-side) evaluation (Flagsmith documents experiments as remote-evaluation only), the `docker.flagsmith.com` images (no Docker daemon in the authoring sandbox), and the full JS/Node SDK experiment methods (the adapter uses the REST endpoints those SDKs use).

## What VariantShield adds beyond native Flagsmith

Flagsmith answers "which variant converts better?". VariantShield answers "is that variant safe to ship?": per-variant operational guardrails (payment failures, duplicate submissions, 5xx, p95 latency) from application telemetry, evaluated independently of conversion, shown beside Flagsmith's result with the evidence behind both, plus a human-approved, audited, state-verified pause. It does not duplicate the statistics engine, Feature Health, release-pipeline gates or the coding-agent setup guide.
