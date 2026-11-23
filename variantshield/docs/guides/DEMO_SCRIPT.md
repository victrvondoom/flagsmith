# Demo script (about 8 minutes)

Independent open-source project, not an official Flagsmith product. Simulated data is always labelled SIMULATION.

## Setup
```bash
npm ci && npm run serve            # prints the admin token, ingest key, issuer key (dev: ephemeral)
```
Open http://127.0.0.1:8787, paste the admin token.

## 1. Reliability guardrails (Phase 1)
1. Command Center: connection and board. Run the **regression** simulation. Trial Board shows BREACH for the treatment variant only.
2. Reliability Observatory: timelines per variant with threshold lines. The latest bucket crosses the line.
3. Dual Verdict Room: Flagsmith says the variant wins, guardrails say it is unsafe, so the verdict is "winning but unsafe".

## 2. Contracts without Flagsmith (simulation)
1. Cross-Surface Contracts, **Load example**, **Validate**, **Register**.
2. Run scenario `valid`: CONTRACT_VALID, all surfaces agree.
3. Run `invalid-combination`: the Feature combination matrix shows the exact feature and surface that violates the constraint.
4. Run `assignment-mismatch`, `environment-mismatch`, `unlinked-identity` and look at Evidence and Contract drift.

## 3. Contracts with a real Flagsmith
```bash
export FLAGSMITH_URL=... FLAGSMITH_ENVIRONMENT_KEY=... FLAGSMITH_ADMIN_API_KEY=...
npm run serve                      # terminal 1
export SURFACE_KEYS=$(npm run -s vs -- contract surface-keys --contract checkout-journey --json | node -e 'process.stdin.on("data",d=>console.log(JSON.stringify(JSON.parse(d).keys)))')
npm run surfaces                   # terminal 2: web, mobile, payment API, risk engine (each holds only its own key)
node scripts/contract-demo.ts      # terminal 3: phases A healthy, B bad combination, C stale variant
```
The Integration page confirms the connection. The CLI gates CI: `npm run vs -- contract check --contract checkout-journey` exits 1 on a violation and 3 when incomplete.

## 4. Talking points
Flagsmith's assignment is reused, never re-implemented. A missing observation is "delayed", not "failed". Unverifiable identity is `IDENTITY_UNLINKED`, never guessed. Contract versions are immutable; findings and drift are kept as history for a configurable period.
