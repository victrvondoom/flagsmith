# Findings: prior art for Flag Bisect (specialist report, 2026-11-26, condensed)

No product or OSS project found that, after an incident, reverts subsets of already-shipped (100%) flag changes for a randomised canary cohort to bisect the culprit.

| Product | On regression | Picks one of several concurrent changes? | On-demand reverted canary? |
|---|---|---|---|
| LaunchDarkly guarded rollouts | sequential test of ONE rollout vs original; notify/pause/rollback | no | no (planned holdout) https://launchdarkly.com/docs/home/releases/guarded-rollouts |
| LaunchDarkly Vega | after rollback, AI root-cause correlation with recent changes | partly, observational | no https://launchdarkly.com/docs/home/observability/vega |
| Harness FME alert policies | per-flag percentage rollout monitoring, "flag X degraded metric Y" | only via each flag's own split | no |
| Statsig | rollout alerts per gate; auto-rollback NOT confirmed in docs | per gate | no |
| Unleash impact metrics/safeguards | threshold rule disables env or pauses plan | no | no |
| GrowthBook Safe Rollouts | 50/50 sequential guardrail test, auto rollback | no | no |
| PostHog issue #113606 (open) | observational scoring, never auto-revert | partly | no |
| AWS AppConfig | CloudWatch alarm rollback per deployment | no | no |
| Flagsmith Feature Health | webhook marks a feature unhealthy; no stats/action (api/features/feature_health) | no | no |
| Flagsmith Release Pipelines | time triggers only; *_FOR_SEGMENT actions are our primitives | no | no |

OSS neighbours: Culprit (sivaram87/Culprit, observational, existing arms), Luau flag-bisect.py (offline ddmin in unit tests), Loglune (offline replay), git bisect.
Research: Zeller 1999 / Zeller & Hildebrandt 2002 (ddmin); Horstein 1963, Waeber-Frazier-Henderson 2013 (noisy bisection); Google FACF ICST 2023 (Bayesian noisy bisection with priors and a no-culprit hypothesis, over commits); Microsoft Gandalf NSDI 2020 (observational); Meta HCM SOSP 2015 (config canaries before rollout).

Per-probe test: plug-in two-sample mSPRT (Johari, Pekelis, Walsh arXiv:1512.04922), always valid:
V = pC(1-pC)/nC + pM(1-pM)/nM; Lambda = sqrt(V/(V+tau^2)) exp(tau^2 theta^2 / (2V(V+tau^2))); CI half-width h = sqrt(V(V+tau^2)/tau^2 (2 ln(1/alpha) + ln((V+tau^2)/V))).
IMPLICATED (healed) if Lambda >= 1/alpha and theta > 0; CLEARED (not healed) if theta + h < rho*Delta; tau = Delta, alpha = 0.05, rho = 0.5. Asymptotic (plug-in variance). Beta-binomial only as a read-out (no error control under repeated looks).

New: on-demand counterfactual cohort from already-shipped changes on live traffic via segment overrides; subset search with an always-valid test per probe; on Flagsmith primitives; human envelope + second person for the kill.
Must NOT claim: invented bisection/noisy bisection/ddmin/culprit finding/priors; no tool attributes regressions to flags; nobody auto-rolls back; first config canary; proven/zero false positives; any metric (proportions only); fast at any traffic (n ~ 1/Delta^2); AI/LLM (deterministic roles); anything about Statsig auto-rollback; "safe because only canary" (say bounded blast radius, capped percent, approved envelope).
Do: confirmation probe with S = {culprit} before any kill; discard first SDK refresh window after each segment change; SRM chi-square check on canary share; report recovered fraction theta/Delta.
