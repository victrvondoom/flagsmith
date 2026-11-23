# Security policy

VariantShield is an independent community project, not an official Flagsmith product.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting ("Security" tab, "Report a vulnerability") on the repository that hosts this project. Include the version, steps to reproduce and impact. Expect an acknowledgement within a few days.

## Security model

| Concern | How it is handled |
|---|---|
| Flagsmith credentials | Read from environment variables on the server only. Never sent to a browser, never logged (`describe()` masks the environment key and omits the credential), never included in error bodies. |
| Dashboard / API access | Every `/api/*` route except `/api/ingest` and `/api/public-config` needs `Authorization: Bearer $VARIANTSHIELD_ADMIN_TOKEN`, compared in constant time. Production (`NODE_ENV=production`) refuses to start without both secrets (min 16 chars). Development generates ephemeral secrets and prints them once. |
| Telemetry ingest | Separate `X-Ingest-Key`. The admin token is not accepted there, and the ingest key cannot read or control anything. Batches are capped (500 events, 1 MiB), validated per event, rate limited and idempotent. |
| Identity (contracts) | Three separate credentials: admin, ingest and a **issuer key** that may only mint identity tokens. `VARIANTSHIELD_IDENTITY_SECRET` HMAC-signs pseudonymous `subjectRef`s and `vsid1` tokens (TTL, constant-time verify); it never leaves the server and surfaces never hold it. Raw ids containing `@` are rejected, so emails cannot enter. An unverifiable token yields `IDENTITY_UNLINKED`, never a guessed identity. Production refuses to start without the secret and issuer key. |
| Privileged actions | Pause/resume/complete need the admin token **and** the exact typed confirmation (`PAUSE <id>`) **and** a reason, are rate limited, serialised per experiment, audited (including refusals that reach the control flow) and verified against Flagsmith afterwards. `dryRun` must be sent explicitly. Nothing runs automatically. |
| PII | Telemetry rejects personal-data fields (`email`, `name`, `ip`, `userAgent`, ...) and any `identityId` containing characters outside `[A-Za-z0-9_-:.]`. Use an opaque or hashed identifier. |
| Browser | Strict CSP (`default-src 'self'`, no inline script or style), `X-Frame-Options: DENY`, `nosniff`, no `innerHTML` in the dashboard. The token lives in `sessionStorage` of one tab. CORS is off unless `CORS_ORIGINS` lists origins. |
| SSRF / path traversal | The bench target must be `http://127.0.0.1` or `localhost`; screenshot paths are validated and confined to the run directory; the child process is spawned without a shell. |
| Supply chain | Zero runtime dependencies (Node built-ins only). Dev dependencies are TypeScript, ESLint and Playwright. |

## Known limitations

* The rate limiter is in-memory and per process; run one API instance or put a limiter in front.
* The admin token is a single shared secret; there is no per-user identity beyond the self-declared actor name in the audit log.
* The checkout demo's fault-injection endpoint is protected by a shared key and must never be exposed publicly.
* TLS is not terminated by VariantShield; put it behind a reverse proxy.
