# VariantShield: Repository Audit

Audit date: 2026-11-23 10:48 IST (before the Toggle Wars opening, 2026-11-26 08:00 IST).
Status: **pre-opening preparation. No product source code has been written.**

## Findings

| Question | Finding (evidence) |
|---|---|
| A. What is checked out? | `victrvondoom/flagsmith`, branch `vsrupeshkumar/zealous-newton-5mhe7m` at `be2bd72` (`git remote -v`, `git branch -vv`). Working tree clean. |
| B. What kind of repo? | A fork of the **Flagsmith core monorepo**: `api/`, `frontend/`, `docs/`, `mcp/`, `experimentation/`, `sdk/`, `openapi.yaml`. Not an SDK or a standalone integration. |
| C. Upstream? | `Flagsmith/flagsmith` (per `CONTRIBUTING.md`). No `upstream` remote is configured locally (`git remote show upstream` fails). Adding one is a safe, non-destructive step for later. |
| D. Existing changes? | None of ours. HEAD is upstream-style history (`fix(E2E)…(#9043)`). Nothing to preserve beyond the clean state. |
| E. Extendable app? | The monorepo is the platform itself, not a host for a third-party console. |
| F. Licence | `LICENSE.md` is BSD-3-Clause (Bullet Train Ltd). Redistribution is permitted with notice retained; the name of the copyright holder must not be used to endorse derived products. Enterprise paths may carry separate terms; check before copying any code. |

## Relevant existing features in this checkout

- Experiment lifecycle API in `openapi.yaml`: `GET/POST …/experiments/`, `…/{id}/start/`, `…/pause/`, `…/complete/`, `…/rollout/`, `…/exposures/`, `…/results/`. Status values: `DRAFT`, `RUNNING`, `PAUSED`, `COMPLETED`. Auth: `tokenAuth` or `Master API Key`.
- Experiment metrics API: `…/experiment-metrics/`.
- Docs: `docs/docs/experimentation/` (beta). Self-hosting needs `EXPERIMENTATION_ENABLED=true`; events can be stored in the Flagsmith Postgres database (evaluation only) or a ClickHouse/Postgres/Databricks warehouse.
- Existing integrations live in `api/integrations/` (Datadog, Grafana, Sentry, etc.): these export flag data outward and are Python/Django plugins.

## Recommendation: separate companion repository

1. **Do not place VariantShield inside this fork.** It is an independent TypeScript app with its own dashboard, API, telemetry service and demo. Putting it in the core monorepo would couple it to Flagsmith's release process, CI and codeowners, and would make any upstream PR unreviewable.
2. **Create `variantshield` as a new repository** (after approval of the name and licence). Suggested licence: Apache-2.0 or BSD-3-Clause (compatible with Flagsmith's BSD-3-Clause; no Flagsmith code is copied).
3. **Use this fork only for upstream work**: compatibility testing against the pinned Flagsmith image, and a possible small docs PR under `docs/docs/third-party-integrations/` once the integration works and maintainers agree.
4. **Do not move or delete anything here.** This audit file is the only addition and should be moved to the companion repo (or dropped) rather than included in any upstream PR.

## Pre-opening boundary (hackathon rule)

Allowed now: this audit, research, architecture, specs, upstream draft, acceptance criteria.
Not allowed until 2026-11-26 08:00 IST: application code, UI, adapter, telemetry, engine, demo.
