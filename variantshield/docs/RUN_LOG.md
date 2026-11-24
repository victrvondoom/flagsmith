# Run log: what was actually executed

Everything below was run on 2026-11-24 in the authoring sandbox. "Real Flagsmith" means Flagsmith built from the source in this repository (`api/`, Django 5.2, Python 3.13) on PostgreSQL 16, started with `runserver`, with two experiments and a second environment created through its own API. "Fake" means the in-process fake in `packages/flagsmith-adapter/src/testing/`. VariantShield ran with `NODE_ENV=production` and randomly generated 32-byte secrets (so the production secret checks were active), over real HTTP between all components.

## Against a real Flagsmith

| What | Command | Result |
|---|---|---|
| Adapter | `node scripts/verify-flagsmith.ts` | all live checks passed; 60 identities spread over 3 variants; results payload parsed (`upi_first` winner, chance to win 99.96%) |
| Contract registration and keys | `npm run vs -- contract register`, `contract surface-keys` | v1 registered; 4 per-surface keys issued |
| Contract demo, 16 customers | `node scripts/contract-demo.ts --customers 16` | **A** `CONTRACT_VALID` (Flagsmith assigned upi_first 8 / control 8, 16 subjects re-verified); **B** `COMBINATION_VIOLATION` on payment-api and risk-engine only; **C** `ASSIGNMENT_MISMATCH` against Flagsmith itself; 44 findings kept as history; all checks passed |
| **Config drift, live** | changed the running experiment's rollout through Flagsmith's own `PATCH .../experiments/2/rollout/` (rollout 100 to 50%, `upi_first` weight 50 to 20%), then `contract check` | fingerprint `2b5fc81095aca8e5` to `acfe91290d177bcf`, exactly 1 drift record written; a check with no change wrote none; restoring the values returned the fingerprint to `2b5fc810...`. The change also produced 20 real `ASSIGNMENT_MISMATCH` findings |
| **Environment mismatch, live** | created a second real environment; ran the risk-engine surface against it | `ENVIRONMENT_MISMATCH` raised: `risk-engine=3011ab1b9d0547ac; payment-api+mobile-checkout+web-checkout=ff0edb8d37d553a0` |
| Human-approved resume | control API against experiment 1 | dry run showed the call; execution without confirmation refused (400); with `RESUME 1` and a reason it went paused to running; an independent read of Flagsmith agreed |
| Reliability demo | `node scripts/live-demo.ts --plan 1 --users 900 --window 60000 --approve "PAUSE 1"` | `WINNER_BUT_UNSAFE`: `upi_first` wins on conversion, payment failures 12.20% (n=123) vs 0.00% (n=87), interval lower bound 5.90%; evidence snapshot stored; human-approved pause went running to paused and Flagsmith confirmed |
| Decision ledger on that data | propose, resolve, `ledger verify`, `ledger export`, offline verify | 13 entries; control actions and evidence were captured automatically; the proposer's own approval was refused (`self_approval_forbidden`); a second actor's approval made decision #10 official; online verification checked hash chain and signatures, offline verification the chain and a pinned head |
| Rule-based assistant | `POST /api/assistant/ask` with the viewer token | cites snapshot #2 and official decision #10; see "Found by running it" below |
| Dashboard | Playwright on the live instance | screenshots `docs/screenshots/live2-*.png`; no console or CSP errors |

## With a real MCP client

`claude mcp add` then `claude mcp list` (Claude Code 2.1.331, isolated `HOME`): `variantshield: Connected`. A `claude -p` session then called `list_subjects` through the server and answered correctly ("2 plans").

## Automated suites

| Suite | Result |
|---|---|
| `npm run check` (strict `tsc`, ESLint, every test) | pass (count in the PR) |
| Playwright variant bench, clean | 27/27 |
| Playwright variant bench, `--fault payment_failures` | 23/27: exactly the 4 tests that exercise payment on `upi_first` fail; `control` and `one_tap` pass |
| CI on the PR | `check`, `docker` (image builds, starts read-only with capabilities dropped, passes its health check, refuses a weak production secret), CodeQL `analyze` |

## Found by running it, and fixed

1. **CLI output truncated at 64 KiB when piped.** `contract check --json` on real data printed 135 KB; it was cut because the process exited right after an asynchronous `console.log`. Output is now written synchronously. The regression test fails without the fix (`Unterminated string in JSON`) and passes with it.
2. **The assistant treated an empty live window as an all-clear.** After the experiment paused and the 60 s window rolled, it recommended "extend: insufficient evidence" although the newest snapshot said `WINNER_BUT_UNSAFE` and decision #10 was PAUSE. It now cites the newest snapshot and the official decision, and holds if there is none.
3. `scripts/live-demo.ts` always used the first imported plan, which was not the experiment the demo app serves. Added `--plan`.
4. An earlier run used a 30 s window with 500 users per phase and never left `INSUFFICIENT_DATA`; sample sizes matter, and the documented defaults (900 users, 60 s) were re-run.

## Observed but not explained

* In the second live run the "healthy" phase reported `reliability=WARNING`. The timeline shows a 16.4% failure bucket from the previous run a few minutes earlier in the same experiment's data, which is a plausible cause, but I did not prove it.

## Not run here

* **Docker and compose.** No Docker daemon in the sandbox. CI builds and starts the image; the compose stacks are only validated with `docker compose config`, never brought up.
* **Firefox and WebKit.** Browser downloads are blocked in the sandbox. `tests/browsers.test.ts` and the `browsers` CI job exist to run the dashboard and the `Secure`-cookie check in both; their results are recorded in the PR once CI has run.
* Flagsmith Cloud and ClickHouse or Databricks warehouses.
* Load beyond the single-process measurements in `IMPLEMENTATION_STATUS.md`.
