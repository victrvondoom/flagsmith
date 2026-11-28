# Cross-surface experiment contracts

A **contract** says how one Flagsmith experiment must behave across several application surfaces (web, mobile, payment API, risk engine, ...). VariantShield checks the contract against what each surface *reports*, using the assignment Flagsmith itself returns.

It answers: do all surfaces see the same canonical customer? Did Flagsmith give them the same variant? Are the resolved feature values a valid combination? Has anything drifted?

It does **not** bucket users, change Flagsmith, or replace Flagsmith's own feature dependencies. It validates an application-level contract that spans services.

## Manifest (YAML or JSON)

See [`examples/checkout-journey.contract.yaml`](../../examples/checkout-journey.contract.yaml).

| Section | Field | Meaning |
|---|---|---|
| `contract` | `id` (slug), `version` (integer >= 1), `description` | Versions are immutable once registered. |
| `experiment` | `key`, `assignment_flag`, `environment` | The experiment, the Flagsmith multivariate flag that assigns the variant, the environment name. |
| | `environment_fingerprint` (optional) | Pins the Flagsmith environment. Get it with `variantshield env-fingerprint <client key>`. |
| | `flagsmith_experiment_id` (optional) | Link to the Flagsmith experiment. |
| `identity` | `strategy: canonical_subject_id`, `require_same_subject` | Surfaces must correlate through one verified subject (see below). |
| `surfaces[]` | `id`, `domain`, `required` (default true), `features` | `features` lists what that surface resolves and must report. Omit for "all". |
| `variants` | `<variant>: { feature: value }` | The value each feature must have for each variant. Every variant defines the same features. |
| `constraints[]` | `id`, `when`, `requires`, `forbids`, `message` | Cross-feature rules. Values may be lists. |
| `freshness` | `max_age_seconds` (900), `correlation_window_seconds` (3600), `missing_surface_grace_seconds` (120) | Staleness, the evaluation window, and how long a silent surface is "delayed". |
| `guardrails` | list of metric ids | Ties the contract to reliability guardrails. |

Validation (`variantshield contract validate`, `POST /api/contracts/validate`) reports every problem with its path and rejects: missing fields, duplicate surfaces, variants missing a feature, constraints naming unknown features or values, unknown guardrails, a surface reporting an unknown feature, **contradictory constraints** (overlapping conditions requiring different values), and **a variant that violates its own constraints**. Unreported features are warnings.

## Identity

A customer must not get unrelated assignments because they hit different surfaces. Identity is therefore *propagated*, never re-invented:

1. A trusted backend (your auth layer) calls `POST /api/identity/issue` with `X-Identity-Issuer-Key` and an **internal opaque id** (emails are rejected). It gets back a pseudonymous `subjectRef` (`sub_…`, an HMAC of the id) and a short-lived signed token (`vsid1.…`).
2. Every surface uses `subjectRef` as the **Flagsmith identity**. Same identity + same environment + stable configuration = same assignment, because Flagsmith's bucketing is deterministic.
3. Surfaces forward the token server-to-server and attach it to each observation. Pass `audience: "<contract id>"` when issuing to scope a token to one contract. VariantShield verifies the signature, expiry and audience; an unverifiable token makes the observation `IDENTITY_UNLINKED`. A bare id or header is never trusted.
4. Anonymous visitors work if a shared anonymous id exists (`{ "anonymousId": "…" }` → `anon_…`).

**Keys.** `VARIANTSHIELD_IDENTITY_SECRET` fixes every customer's pseudonym and must never be rotated (it would re-bucket everyone in Flagsmith). Tokens use a separate key you can rotate: set the new `VARIANTSHIELD_IDENTITY_TOKEN_SECRET` and list the old one in `VARIANTSHIELD_IDENTITY_TOKEN_PREVIOUS` until live tokens expire.

**Reporting keys.** Each surface reports with its own key, bound to one contract and surface: `npm run vs -- contract surface-keys --contract <id> --json`. Give each service only its key. The master ingest key cannot write observations. Rotating the ingest key rotates all surface keys.

Browsers on different origins do not share cookies or storage. Carry the token with the request (server-side session, header, or signed redirect parameter); do not assume a shared cookie.

## What is checked

| Code | Meaning |
|---|---|
| `ASSIGNMENT_MISMATCH` | Surfaces report different variants for one subject, or a surface differs from what Flagsmith assigns *now* (re-verified on `check`). |
| `ASSIGNMENT_MISSING` | A surface did not obtain an assignment. |
| `ENVIRONMENT_MISMATCH` | A surface used another environment (name, pinned fingerprint, or differing fingerprints). Flagsmith buckets environments independently, so no parity is promised across them. |
| `IDENTITY_UNLINKED` | Missing, forged or expired token. Excluded from the matrix, never guessed. |
| `CONTRACT_VERSION_MISMATCH` | A surface reports against another contract version. |
| `COMBINATION_VIOLATION` | Resolved values contradict the variant table, a constraint, or each other. |
| `MISSING_REQUIRED_FEATURE`, `UNKNOWN_FEATURE_VALUE`, `UNKNOWN_VARIANT` | A required value is absent, or a value/variant is not in the contract. |
| `MISSING_SURFACE`, `STALE_OBSERVATION` | Coverage and freshness. **Not violations**: "delayed" (info) inside the grace period, then "incomplete coverage" (warning). A missing observation never proves a service failed. |

Contract status: `CONTRACT_VALID`, `CONTRACT_VIOLATION` (any error), `CONTRACT_INCOMPLETE` (warnings only), `NO_DATA`.

## Drift (never rewrites history)

* Registering a new version records every difference from the previous one (version, environment, assignment flag, surfaces, variant values, constraints, freshness) with severity and affected surfaces. Old versions, their observations and their findings stay as they were; evaluate any version with `?version=`.
* Observations that change for the same subject and surface (variant, a feature value, environment, version) are recorded at ingest.
* A surface that reported in the previous window and is silent now is recorded, worded as "cannot tell which" (traffic, deploy or outage).
* On `check`, VariantShield reads Flagsmith's assignment configuration (default state plus the experiment's segment override with option percentages), fingerprints it, and records a change with the warning that **changing weights during a running experiment can change which variant some identities receive**.

## Run it

```bash
# validate locally, machine-readable
npm run vs -- contract validate --file examples/checkout-journey.contract.yaml --json

# register, then gate CI on the result (exit 1 violation, 3 incomplete/no data)
export VARIANTSHIELD_URL=http://127.0.0.1:8787 VARIANTSHIELD_ADMIN_TOKEN=...
npm run vs -- contract register --file examples/checkout-journey.contract.yaml
npm run vs -- contract check --contract checkout-journey
npm run vs -- contract report --contract checkout-journey --json

# deterministic simulation, no Flagsmith needed (labelled SIMULATION)
curl -XPOST -H "Authorization: Bearer $VARIANTSHIELD_ADMIN_TOKEN" $VARIANTSHIELD_URL/api/simulate/contract/invalid-combination
```

Simulation scenarios: `valid`, `invalid-combination`, `assignment-mismatch`, `environment-mismatch`, `unlinked-identity`. They use the contract id `sim-checkout-journey`, a deterministic variant split (not Flagsmith), and cannot be written to by real surfaces.

### Live, with a real Flagsmith

```bash
# four sample surfaces (web, mobile simulator, payment API, risk engine) on :8801-8804
export SURFACE_KEYS='{"web-checkout":"vss1...",...}'   # from: npm run vs -- contract surface-keys --contract checkout-journey --json
FLAGSMITH_URL=... FLAGSMITH_ENVIRONMENT_KEY=... SURFACE_CONTROL_KEY=... npm run surfaces
node scripts/contract-demo.ts --customers 12     # phases A healthy, B bad combination, C stale variant; exits 1 on any surprise
```

Reporting from your own services: see `apps/surfaces/src/surface.ts` (about 60 lines of logic) and `POST /api/contract-observations` in `docs/API.md`.

## Semantics worth knowing

* For each subject and surface the **latest** observation in the window decides the cell; earlier ones are kept as evidence and drive observation-level drift.
* `observedAt` comes from the surface's clock but is bounded: more than 60 s ahead of the server is rejected.
* History is kept for `VARIANTSHIELD_HISTORY_RETENTION_DAYS` (default 365) and observations for `RETENTION_DAYS` (default 10); a contract holds at most `VARIANTSHIELD_MAX_OBSERVATIONS_PER_CONTRACT` observations (default 500000).
* An anonymous id and an authenticated id are different subjects: there is no linking, so a visitor who logs in mid-journey counts as two subjects and may be bucketed differently by Flagsmith.
* If Flagsmith's targeting depends on traits, surfaces that send different traits can legitimately get different variants. VariantShield flags the mismatch but does not capture traits.

## Limits

* Contracts compare what surfaces *report*; VariantShield cannot see a surface that never reports.
* Flagsmith re-verification calls the identities endpoint for up to 100 recent subjects per check (cached 60 s).
* The assignment-config fingerprint relies on Flagsmith's project-level feature-state endpoint; it was verified against the Flagsmith source and a live instance but may change with Flagsmith versions.
* One experiment per contract; one shared signing secret for identities.
