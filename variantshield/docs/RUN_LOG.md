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

## Cross-browser, run in CI (the sandbox cannot download Firefox or WebKit)

`tests/browsers.test.ts` runs in the CI job `browsers` for Firefox and WebKit (Chromium is covered by the main suites). On the head commit both pass: the dashboard signs in, renders the Decision Ledger, answers an assistant question and fits a 390 px screen without horizontal scroll, and the checkout demo's identity cookie comes back on the next request. WebKit failed first, and the failures were real:

1. **Cookie.** WebKit does not send back a `Secure` cookie over `http://127.0.0.1`. The `Secure` flag had been added to satisfy a CodeQL finding, so on Safari the demo issued a new identity, and therefore a new variant, on every request. Now `Secure` is omitted only when the client is on loopback over plain HTTP; every remote client, and HTTPS behind a trusted proxy, still gets it. Each branch spells out its flags literally, which also cleared CodeQL's "missing httpOnly" finding.
2. **Layout.** At 390 px the page scrolled 15 px sideways in WebKit only. Per-element measurement showed every box fit, and the overflow came from the text inside a `<select>`, which WebKit does not clip when the select is narrower than its longest option. Selects now clip their text, and a duplicated "[SIM] [SIMULATION]" label was shortened.

## Observed but not explained

* In the second live run the "healthy" phase reported `reliability=WARNING`. The timeline shows a 16.4% failure bucket from the previous run a few minutes earlier in the same experiment's data, which is a plausible cause, but I did not prove it.

## Not run here

* **Docker and compose.** No Docker daemon in the sandbox. CI builds and starts the image (`docker` job); the compose stacks are only validated with `docker compose config`, never brought up.
* Flagsmith Cloud and ClickHouse or Databricks warehouses.
* Load beyond the single-process measurements in `IMPLEMENTATION_STATUS.md`.

## Incident Bisect against a real Flagsmith (2026-11-27)

Flagsmith built from this repository's `api/` (Django 5.2, PostgreSQL 16, v1 versioning), environment "Production". VariantShield ran with `NODE_ENV=production` and random 32-byte secrets. Command: `node scripts/storefront.ts --rps 60 --auto --webhook <secret>`. Every live request asked Flagsmith's SDK endpoint (`/api/v1/identities/`) which flags the shopper gets, so the canary overrides were evaluated by Flagsmith itself; the shoppers' failure behaviour is the only synthetic part (hidden culprit `new_tax_engine`, 1% → 9%).

| Step | Result |
|---|---|
| Deploy | 6 flags changed through Flagsmith's own API in 8 s |
| Sentinel | onset at the deploy minute; failure rate 0.93% → 8.63% |
| Archivist | 6 changes found by the flag watcher (13 recorded diffs, including the reset) |
| Envelope | approved by alice (ledger #2), 10% canary |
| Round 1 | revert fast_checkout, new_tax_engine, dark_mode_default → **healed** (canary 2.63% vs main 8.20%, evidence 170) |
| Round 2 | revert 4 others → not healed (8.34% vs 8.80%) |
| Round 3 | revert address_autocomplete, promo_banner, new_tax_engine → **healed** (1.32% vs 9.56%) |
| Round 4 | revert the other 5 → not healed (10.30% vs 8.58%) |
| Round 5 (confirmation) | revert only new_tax_engine → **healed** (0.65% vs 8.94%, evidence 2.1e13) |
| Conclusion | culprit `new_tax_engine`, 99.1% |
| Remediation | proposed by alice, approved by bob; `new_tax_engine` read back as off; the 5 innocent changes stayed live |
| Recovery | RESOLVED about 2 minutes later; 32,694 live requests in total |
| Clean-up | 0 `vs-canary-*` segments left in Flagsmith; ledger 12 entries, chain and signatures verify |

Screenshots: `docs/screenshots/live-incident-resolved-{dark,light}.png`.

### Found by running it, and fixed

1. **No change history on a self-hosted open-source Flagsmith.** The first live incident closed as "not a flag change" with six changes just made. Two Flagsmith behaviours combined: webhooks to private addresses are refused (`URLs must not target internal or private network addresses.`), and the audit list was empty because `audit_log_visibility_days` defaults to 0 (`api/organisations/models.py`). Added a flag watcher (SDK `/api/v1/flags/` every 5 s, diffed) and a regression test with no webhook and an empty audit log.
2. **Canary segment refused (400).** Flagsmith's serializer rejects a blank `property` for `PERCENTAGE_SPLIT`, although the engine treats blank as the identity key. Now `$.identity.key`; on the real instance a 10% split matched 35 of 400 identities. The adapter now includes Flagsmith's 400 body in its error.
3. **Every change counted as "after the onset".** The onset is dated to its minute bucket, so changes inside that minute got almost no prior. Priors now measure lag to the end of the onset minute.
4. **A suspect's "before" came from its first change in the window**, so a flag reset and changed again looked unchanged. Now the value just before its latest change (what a revert restores).
5. Found in simulation before going live: node:sqlite binds JS numbers as REAL, so `ts / ?` never grouped into minutes; the bucket width is now an integer literal.
