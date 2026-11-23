# Self-hosting

## What you need

* Node 22.18+ (or Docker). No database server: VariantShield stores its own state in SQLite (`VARIANTSHIELD_DB_PATH`, default `data/variantshield.db`).
* A self-hosted Flagsmith with experimentation enabled and the values in `FLAGSMITH_SETUP.md`.

## Run from source

```bash
cd variantshield
npm ci
cp .env.example .env            # fill in the secrets; load with your shell or process manager
npm run serve                   # API + dashboard on http://127.0.0.1:8787
npm run demo:checkout           # checkout demo on http://127.0.0.1:8791 (needs FLAGSMITH_* and VARIANTSHIELD_* set)
```

Without secrets set, development mode prints ephemeral ones on start. Open <http://127.0.0.1:8787> and sign in with the admin token.

Health checks: `GET /health` (liveness), `GET /ready` (database + a live Flagsmith probe, cached for 10 s).

## Run with Docker Compose

```bash
cd variantshield
cp .env.example .env                                    # set the two secrets and the Flagsmith keys
docker compose up --build                               # VariantShield + demo, Flagsmith already running on the host
docker compose -f compose.with-flagsmith.yaml up --build   # also starts Flagsmith from its published images
```

`compose.with-flagsmith.yaml` mirrors Flagsmith's own `docker-compose.yml` (PostgreSQL 15.5, `docker.flagsmith.com/flagsmith/flagsmith:latest` for migrate and serve) and does not copy any Flagsmith code. VariantShield data persists in the `variantshield-data` volume; containers have health checks.

### Verification status

* **Verified**: running the API, dashboard, checkout demo and bench from source against a real Flagsmith API built from the Flagsmith repository (Django + PostgreSQL 16). See `FLAGSMITH_INTEGRATION_RESEARCH.md`.
* **Not verified**: `docker compose` itself and the `docker.flagsmith.com` images. The authoring environment had no Docker daemon, so the Dockerfile and both compose files are only syntax-checked (YAML parses). Please report issues you hit.

## Production notes

Set `NODE_ENV=production`, strong secrets, `HOST` behind a TLS reverse proxy, and `CORS_ORIGINS` only if you need it. Use a dedicated Flagsmith warehouse for event volume (the Flagsmith database option is for evaluation). Guardrail defaults need sample floors of 200 (rates), 500 (5xx) and 100 (latency) per variant per window; tune them per plan under *Trial Board > guardrail overrides* or globally with `GUARDRAIL_CONFIG_JSON`.
