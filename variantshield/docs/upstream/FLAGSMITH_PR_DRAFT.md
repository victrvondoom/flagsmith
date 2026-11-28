# DRAFT, NOT SUBMITTED. Only open after the issue in `FLAGSMITH_ISSUE_DRAFT.md` receives maintainer agreement.

**Target:** `Flagsmith/flagsmith`, branch `main` (per `CONTRIBUTING.md`), unless the issue says otherwise.

**Title:** docs: add VariantShield community integration guide

VariantShield is an independent community project, not an official Flagsmith product or an endorsed integration. This PR is documentation only. The application lives in a separate companion repository; **no application code is proposed for this repository.**

## Proposed change

One new page, `docs/docs/third-party-integrations/observability-and-monitoring/variantshield.md` (frontmatter in the style of the neighbouring pages), covering:

1. What it does and does not do (reads Flagsmith's results; never recomputes statistics; never acts without a human).
2. Prerequisites: self-hosted Flagsmith with `EXPERIMENTATION_ENABLED=true`, a "Flagsmith database" or warehouse connection, a Management API key.
3. The endpoints it uses (experiments, results, exposures, identities, events, start/pause/complete) with the exact auth schemes.
4. Setup steps and a link to the companion repository.

## Evidence of working compatibility

Run against a Flagsmith API built from Flagsmith source at commit `be2bd72` (Django, PostgreSQL 16):

```
node scripts/verify-flagsmith.ts --lifecycle --events 400
PASS list experiments ... PASS read results and parse real payload ... PASS pause experiment
PASS Flagsmith reports paused after pause ... PASS resume experiment    All live checks passed
```

and an end-to-end demo (`scripts/live-demo.ts`) in which a conversion winner is detected as operationally unsafe and paused with explicit human confirmation. Automated tests: 112 passing (unit, API integration, end to end, Playwright UI).

## Checklist

- [ ] Maintainers agreed on the issue
- [ ] Page builds with `make lint` in `docs/` (Prettier)
- [ ] Links verified; companion repository URL added
- [ ] Wording confirmed as "community integration"
