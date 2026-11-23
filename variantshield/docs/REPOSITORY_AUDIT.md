# Repository audit

Audit run 2026-11-23 (`pwd`, `git status`, `git remote -v`, `git branch -vv`, `git log`, tree, manifests, licence, CONTRIBUTING, workflows, Docker config).

| Question | Finding |
|---|---|
| Which repository is checked out? | `victrvondoom/flagsmith`, a fork of the Flagsmith core monorepo (`api/`, `frontend/`, `docs/`, `mcp/`, `experimentation/`, `sdk/`, `openapi.yaml`). Working branch `vsrupeshkumar/zealous-newton-5mhe7m`. |
| Fork of what? | `Flagsmith/flagsmith` (upstream). No `upstream` git remote is configured locally. |
| Existing changes? | None beyond upstream history at the start of the work. |
| Extendable app? | No. The monorepo *is* the platform; it has no place for a third-party reliability console. |
| Licence | `LICENSE.md` is BSD-3-Clause (Bullet Train Ltd). VariantShield uses BSD-3-Clause too and **copies no Flagsmith code** (it talks to Flagsmith over HTTP and mirrors response shapes it read from `api/experimentation/`). |

## Repository strategy

VariantShield is an independent TypeScript application and must not become part of the Flagsmith platform. Decision:

1. **It lives in a single self-contained directory, `variantshield/`, with no imports from the rest of the monorepo.** It builds, tests and deploys on its own (`cd variantshield && npm ci && npm test`).
2. **Extraction path:** `git subtree split --prefix=variantshield -b variantshield-standalone` produces a clean standalone repository with history. This is the recommended home for the project once a maintainer-owned repository exists. Nothing in the directory depends on the fork.
3. **The fork stays useful for upstream work only:** compatibility testing against Flagsmith's own source (done: see `FLAGSMITH_INTEGRATION_RESEARCH.md`, "Live verification") and, if maintainers agree, a small documentation PR. The whole application is **never** proposed upstream as a core-platform change.
4. Existing Flagsmith code, docs and CI were not modified. Added outside `variantshield/`: `.github/workflows/variantshield-ci.yml` (path-filtered to `variantshield/**`).

## Pre-existing hygiene note

The first local commit accidentally staged `node_modules/`. It was never pushed and was removed from history before pushing (the commit was re-created from a soft reset). `.gitignore` now excludes `node_modules/`, `data/`, `.env` and databases.
