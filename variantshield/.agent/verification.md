# Verification (Phase D), 2026-11-27

| Check | Result | Evidence |
|---|---|---|
| `npm run check` (tsc strict, ESLint, all tests) | pass, 321 tests, 0 failures | exit 0 |
| Bisect engine unit tests | 15 pass | Beta function vs closed forms, planner splits, mSPRT verdicts, CUSUM onset, 40-seed property test |
| Swarm API tests | 7 pass | simulated pair, not-a-flag, abort, envelope limits; fake Flagsmith end to end (webhook, audit, overrides, remediation); watcher-only regression |
| Incident Room browser journey | pass | two people through both gates, live updates, 390 px without horizontal scroll, no console errors |
| Live run on real Flagsmith | pass | docs/RUN_LOG.md; 4 defects found live and fixed with tests |
| Planner benchmark | run | scripts/bisect-bench.ts, 200 seeds per case |
| Firefox/WebKit | not run locally (no browsers in sandbox); CI job `browsers` covers existing pages |
| HawkScan | not run: HAWK_API_KEY is not set in this environment |
| Docker compose stack | not run (no Docker daemon) |
