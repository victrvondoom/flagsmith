# Verification log

What was run against Flag Bisect, what broke and how each fix was proven. Every fix is its own commit with a regression
test, on a branch reviewed through a draft pull request; nothing is merged without approval.

## Bugs found and fixed

| #   | Found by                                                                       | Symptom                                                                                                                                                                   | Fix                                                                                                                                                                                                                                                                                               | Regression test                                                                                                                                            |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Canary revert on a multivariate flag, both versioning modes, custom split      | With feature versioning, the canary override took the flag's default weights (30/30/40) instead of the environment's (10/0/90), so a probe changed variants too           | The canary override carries the environment's current variants; sent only for multivariate flags, which alone accept them                                                                                                                                                                         | `test_variants.py::test_apply__multivariate_suspect__canary_keeps_the_variant_split[v1, v2]`                                                               |
| 2   | Reading ingestion against the events endpoint's rules (24 h of future skew)    | An event from an SDK clock running ahead was skipped, but the cursor moved past it, so it was never counted                                                               | Future-dated events count at the time they are read                                                                                                                                                                                                                                               | `test_signal_source.py::test_ingest_experimentation_events__mixed_events__counts_outcomes_by_event_minute`                                                 |
| 3   | Live run 2: resolved at "2.57%" with a 0.90% baseline, 2 minutes after the fix | Recovery was judged on the last three minutes, including minutes from before the fix                                                                                      | Only complete minutes that start after the fix count; the message names the baseline                                                                                                                                                                                                              | `test_services_edges.py::test_watch_environment__remediated__judges_only_complete_minutes_after_the_fix`                                                   |
| 4   | Full suite after fix 1                                                         | Sending `variants: []` for an ordinary flag is refused by Flagsmith ("Feature is not multivariate"); four end-to-end tests failed                                         | Part of fix 1: variants are sent only when the flag has a split                                                                                                                                                                                                                                   | The four end-to-end tests in `test_services.py`                                                                                                            |
| 5   | Docker build from this network                                                 | `public.ecr.aws` refused the Node base image with `429 Too Many Requests`                                                                                                 | `NODE_IMAGE` and `WOLFI_BASE_IMAGE` build arguments, defaults unchanged; the demo compose file passes them through                                                                                                                                                                                | `docker compose config` with and without the override; the build resolved every base image from Docker Hub                                                 |
| 6   | Operating the task processor                                                   | After four failed passes (the database refusing connections), the processor disabled the swarm's task, and no incidents opened                                            | Documented under "Things to know"; it is how Flagsmith treats every recurring task                                                                                                                                                                                                                | Reproduced and recovered live                                                                                                                              |
| 7   | Engine stress: 2,592 simulated incidents                                       | With the fixed 5% canary, about half the incidents ran out of rounds or minutes, and nobody was told in advance, e.g. 91% inconclusive at 600 outcomes a minute for 1%→9% | The Guardian sizes the canary from the traffic since the onset and the size of the regression (the smallest of 5/10/15/20% expected to decide a probe in 5 minutes, using the Judge itself on expected counts), says how long a probe should take, and warns before approval when no size will do | `test_engine.py::test_recommend_canary__…`, `test_minutes_to_decide__…`; `test_services_edges.py::test_investigate__traffic_since_onset__sizes_the_canary` |

Bug 4 was introduced by the first version of fix 1 and caught by the full suite before the fix was considered done.

## Configurations run

| Variant                                                                 | Result                                                                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Feature versioning off (v1) and on (v2)                                 | Both run end to end in the test suite: found, confirmed, restored by two people         |
| Outcomes from `POST /api/v1/flag-bisect/signals/`                       | Live run 1: `new_tax_engine` at 99.1% in 5 rounds, resolved, 67,776 requests            |
| Outcomes from Experimentation events (`POST /api/v1/events`)            | Live run 2: `new_tax_engine` at 99.1% in 5 rounds, resolved, no canary segments left    |
| Flag under a running experiment                                         | Left alone with a message; with nothing else to test, ends as not a flag change         |
| Multivariate flag with an environment-specific split                    | Canary keeps the split (fix 1)                                                          |
| Typed values: string, integer, boolean; a flag switched on and back off | Reported with the right before and after; the round trip is reported as its net change  |
| Change requests required                                                | Envelope approval refused                                                               |
| Same person proposing and approving; user and API key; two API keys     | Refused when it is the same actor, accepted otherwise                                   |
| Harmful canary; confirmation that does not heal; nothing left to learn  | Aborted with the canary removed; back to probing; envelope exhausted                    |
| `FLAG_BISECT_ENABLED=false`                                             | API returns 404 and the task does nothing                                               |
| Dashboard in light and dark, 1440 px and 390 px                         | Every incident state renders; no horizontal scroll; no errors from Flag Bisect requests |

## Engine stress

`2,592` simulated incidents across 432 shapes (2 to 16 changes; one culprit, a pair that only fails together, or no
flag; regressions of 1%→9%, 1%→4% and 5%→10%; 5%, 10% and 20% canaries; 600 and 1,400 outcomes a minute), driven the way
the service drives the engine:

- No crashes.
- One wrong answer in 2,592: a "not a flag" incident confirmed on a flag. A wrong answer needs two wrong probes at a
  nominal 5% each, which this rate is consistent with.
- About half ended inconclusive inside the default envelope (12 rounds, 45 minutes) with a fixed 5% canary (bug 7).
- Choosing a probe takes at most 0.5 s (14 suspects), well inside the 30-second task.

With the canary sized from traffic (bug 7), 720 simulated incidents over the same regressions and traffic:

| Regression, outcomes a minute | Proposed canary | Expected minutes a probe | Inconclusive |
| ----------------------------- | --------------- | ------------------------ | ------------ |
| 1%→9%, 1,400                  | 10%             | 4.5                      | 0%           |
| 1%→9%, 600                    | 20%             | 5.5                      | 0%           |
| 5%→10%, 1,400                 | 20%             | 6.5                      | 3%           |
| 1%→4%, 1,400                  | 20%             | 8                        | 7%           |
| 5%→10%, 600                   | 20%             | too slow, warned         | 61%          |
| 1%→4%, 600                    | 20%             | too slow, warned         | 79%          |

Inconclusive results now happen almost only where the Guardian warned, before approval, that the traffic is too low.
Wrong answers stayed at 1 in 720.
