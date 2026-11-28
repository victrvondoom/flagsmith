# DRAFT, NOT PUBLISHED. Needs the owner's approval before posting anywhere.

**Title:** Proposal: Variant-level reliability guardrails for Flagsmith experimentation

**Disclosure:** VariantShield is an independent community project. It is not an official Flagsmith product and is not endorsed by Flagsmith.

## Duplicate check (2026-11-23)

Searched `Flagsmith/flagsmith` issues for: `guardrail`, `experiment pause`, `experimentation latency OR "error rate" OR reliability`, `experiment metrics guardrail`. No existing issue covers operational guardrails per variant. One related open proposal, #9006 (Ruphex, AI-agent implementation verification), was opened by the same GitHub account for a different project; the two are complementary (verification of candidate code vs. operational health of a live experiment) and should cross-reference each other. **Not checked:** GitHub Discussions and the Flagsmith community channels; check those before posting.

## The concrete problem

An experiment can win on its primary metric while damaging reliability. Example: a new checkout variant raises purchase completion, but payment failures, duplicate submissions and p95 latency regress. Flagsmith's experiment results answer *which variant converts better*; teams currently have to correlate error rates and latency with the served variant by hand in their observability tool.

## Why it matters

Conversion winners are the ones teams are most eager to ship. A reliability regression that only affects one variant is invisible in aggregate dashboards (the control dilutes it) and shows up late, as an incident.

## What native Flagsmith functionality is reused

Everything experimental stays in Flagsmith: the experiment lifecycle (`start`/`pause`/`complete`), variant assignment (identities endpoint), exposures and conversion events, and the Bayesian results (`chance_to_win`, credible intervals). VariantShield only **reads** those and never recomputes statistics.

## What the independent integration adds

* Variant-aware application telemetry (`feature_flag.key`, `feature_flag.result.variant` per the OpenTelemetry feature-flag conventions) with idempotent ingest, PII rejection and explicit "unattributed" accounting.
* A deterministic guardrail engine (payment failures, duplicates, 5xx, p95) comparing each variant to the control with minimum sample sizes. It returns `INSUFFICIENT_DATA | HEALTHY | WARNING | BREACH | RECOVERING` and never reports health without data.
* A **dual verdict**: Flagsmith's result beside the reliability result, with the evidence and a clear outcome (winner and safe / winner but unsafe / ...).
* A human-approved, audited pause through Flagsmith's documented endpoint, with a dry run and before/after state verification.

## Self-hosted and privacy

Works with a self-hosted Flagsmith using only the public REST API and SDK endpoints; no changes to Flagsmith. Credentials stay server-side; telemetry carries only opaque identity ids.

## Evidence it works

Verified against a real Flagsmith API built from `main` (Django + PostgreSQL): variants served by the identities endpoint, events accepted, real results parsed, pause/resume verified by re-reading state. 112 automated tests including a Playwright suite. Details: `docs/FLAGSMITH_INTEGRATION_RESEARCH.md` in the companion repository.

## Questions for maintainers

1. Is the **results payload** (`metrics[].variants` / `inference`) a supported, stable integration surface, or should integrations expect it to change? The OpenAPI schema `ExperimentResults` (`winner`, `significant`, `p_value`) does not match what `GET .../results/` returns.
2. Is there an intended way to attach a **guardrail metric** natively (e.g. a metric with `direction: down` and a "must not regress" flag)? If so, this integration should defer to it.
3. Are `start`/`pause`/`complete` intended for third-party callers with a Management API key, and is `Api-Key` or `Token` preferred?
4. Would a short community-integration page under `docs/docs/third-party-integrations/` be welcome, or is that section reserved for officially supported integrations?
5. Any plans to expose variant labels in the identities response, so integrations need not treat `feature_state_value` as the variant key?
