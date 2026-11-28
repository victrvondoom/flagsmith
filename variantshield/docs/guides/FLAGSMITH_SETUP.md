# Flagsmith setup for the checkout experiment

These are the exact steps used (via the REST API) to verify VariantShield against a real Flagsmith. You can do the same in the Flagsmith UI.

1. **Run Flagsmith with experimentation on**: `EXPERIMENTATION_ENABLED=true` (see `SELF_HOSTING.md`).
2. **Create** an organisation, a project and an environment. Note the environment's **client-side API key** (`FLAGSMITH_ENVIRONMENT_KEY`).
3. **Create a multivariate feature `checkout_flow`**: control value `control`; two options with string values `upi_first` and `one_tap`. Variant keys are the option values, and VariantShield treats the served `feature_state_value` as the variant key.
4. **Connect event storage**: *Environment Settings > Warehouse > Flagsmith database > Enable* (evaluation only; use a dedicated warehouse in production). Via API this is a `postgres` connection with `config {"source": "flagsmith_database"}`.
5. **Create a metric** (occurrence, higher is better) on event `checkout_completed`.
6. **Create an experiment** on `checkout_flow` with that metric and a rollout (e.g. 100% of identities, equal split). Start it from the UI or with VariantShield's Experiment Control.
7. **Create a Management API credential** for VariantShield: a master API key (`FLAGSMITH_ADMIN_API_KEY`, sent as `Authorization: Api-Key`) or a user token (`FLAGSMITH_ADMIN_TOKEN`, sent as `Authorization: Token`). It needs permission to view experiments and, for control actions, to change them.
8. **Verify** from `variantshield/`:

```bash
export FLAGSMITH_URL=http://localhost:8000 FLAGSMITH_ENVIRONMENT_KEY=<client key> FLAGSMITH_ADMIN_API_KEY=<master key>
node scripts/verify-flagsmith.ts                 # read-only checks
node scripts/verify-flagsmith.ts --lifecycle --events 400   # also starts/pauses/resumes and sends events (changes state!)
```

Flagsmith allows one results/exposures refresh per five minutes. The verify script reports a throttle as `SKIP`, not a failure.

## Synthetic seed (optional, labelled)

To make Flagsmith name a winner quickly in a demo, `node scripts/seed-synthetic-events.ts --identities 6000` posts exposures and conversions for fake identities. Do not run it on an experiment you care about.
