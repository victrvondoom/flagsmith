# Contributing

Thanks for helping. VariantShield is an independent community project (not an official Flagsmith product).

## Setup

```bash
cd variantshield
npm ci
npx playwright install chromium   # only needed for the bench and UI tests
npm run check                     # typecheck + lint + all tests
```

Node 22.18 or newer. No build step: TypeScript runs through Node's type stripping, so use only erasable syntax (no `enum`, no constructor parameter properties). `tsc --noEmit` enforces strict mode.

## Working on contracts

`packages/contracts` is pure (no I/O); keep it that way and put persistence in `apps/api/src/contracts.ts`. New finding codes need: a type in `types.ts`, a unit test in `contracts.test.ts`, a row in `docs/guides/CONTRACTS.md`, and a dashboard label. Run the sample surfaces with `npm run surfaces` and the live driver with `npm run demo:contracts`. Never log or return identity secrets or tokens.

## Ground rules

* **Never fake Flagsmith.** Real behaviour is tested against the contract double in `packages/flagsmith-adapter/src/testing/fake-flagsmith.ts`, which is built from Flagsmith's source and clearly labelled as a double. If you change an adapter assumption, verify it against a real Flagsmith with `scripts/verify-flagsmith.ts` and note the result in your PR.
* **Simulation stays labelled and separate.** Synthetic data uses `source: "simulation"` and is never mixed into `real` queries.
* **Never claim healthy without data.** `INSUFFICIENT_DATA` outranks `HEALTHY` by design; keep the engine tests (`engine.test.ts`) honest.
* **Mutations need a human.** Any new control action must follow `apps/api/src/control.ts`: dry run, typed confirmation, reason, audit, before/after verification.
* Tests follow `subject__condition__expected_outcome`, Given/When/Then, no class-based tests. Add a regression test with every fix.
* British English in docs and UI text.

## Pull requests

Keep them focused, describe how you verified the change (command output, not assertions), and update docs when behaviour changes.
