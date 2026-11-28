# Demo script and recording checklist

Two ways to run it: **simulation** (no Flagsmith needed, labelled synthetic) or **live** (real Flagsmith).

## A. One command: both scenarios, simulated

```bash
cd variantshield && npm ci && npm run simulate
```

Prints the safe winner (`WINNER_AND_SAFE`) and the dangerous winner (`WINNER_BUT_UNSAFE`, recommends pause) with the evidence lines. Deterministic and clearly marked SIMULATION; Flagsmith is not contacted.

## B. Live, with a real Flagsmith (the 14 steps)

Prerequisites: `FLAGSMITH_SETUP.md` done. Terminal 1 `npm run serve`; terminal 2 `npm run demo:checkout` (with `DEMO_ALLOW_UID_HEADER=true DEMO_EXPERIMENT_ID=<id> DEMO_LATENCY_SCALE=0.02`); terminal 3:

```bash
export VARIANTSHIELD_ADMIN_TOKEN=... DEMO_CONTROL_KEY=...
node scripts/live-demo.ts --users 900 --window 45000
```

| # | Step | Where it happens |
|---|---|---|
| 1 | Start self-hosted Flagsmith | `compose.with-flagsmith.yaml` or your instance |
| 2 | Connect VariantShield | Command Center shows "Flagsmith Management API reachable" |
| 3 | Import / inspect the checkout experiment | `Import experiments from Flagsmith` |
| 4 | Variants assigned | Flagsmith identities endpoint; visible in the demo page and `identity assignments` output |
| 5-7 | Run traffic; exposures, conversions and telemetry captured | `live-demo.ts` phase 1; Observatory |
| 8 | Compare variants | Reliability Observatory |
| 9 | Trigger a controlled failure | live-demo injects payment failures on `upi_first`; or run the Variant Bench with a fault |
| 10-11 | Still a conversion winner, but fails guardrails; show evidence | Dual Verdict Room: `WINNER_BUT_UNSAFE`; capture evidence snapshot |
| 12 | Human approval | Experiment Control: dry run, then type `PAUSE <id>` and a reason (or `--approve "PAUSE <id>"`) |
| 13 | Pause through Flagsmith | audit row `executed` |
| 14 | Confirm the changed state | "Flagsmith status: paused" (an independent re-read) |

## Talking points

* Flagsmith decides the winner; VariantShield decides whether it is safe. They are shown separately.
* "Insufficient data" is a first-class answer. Nothing is called healthy without samples.
* No button does anything automatically; pause needs a typed confirmation and is verified afterwards.
* Simulation is always labelled and never mixed with real telemetry.

## Recording checklist (3 minutes)

- [ ] 1920x1080, dark and light mode both checked, zoom 110%
- [ ] Browser history/bookmarks hidden; no real tokens on screen (use throwaway ones)
- [ ] Start at Command Center with Flagsmith connected
- [ ] Show the safe winner verdict first, then the dangerous one
- [ ] Open the Observatory and point at the breached metric, sample counts and thresholds
- [ ] Show Variant Bench with the injected fault and the failing screenshot next to a passing one
- [ ] Do the pause live: dry run, wrong confirmation (disabled button), correct confirmation, success
- [ ] End on the audit trail and the paused state
- [ ] State clearly: independent community project, not an official Flagsmith product
