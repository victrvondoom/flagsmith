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
| Identity (contracts) | Separate credentials: admin (optionally a read-only viewer), ingest (telemetry only), an **issuer key** that may only mint identity tokens, and **one reporting key per surface**. `VARIANTSHIELD_IDENTITY_SECRET` fixes the pseudonymous `subjectRef`s and must never rotate (it would re-bucket every customer); tokens are signed with a separate, rotatable key (`VARIANTSHIELD_IDENTITY_TOKEN_SECRET`, old keys in `_PREVIOUS`), carry a random `jti`, and can be scoped to one contract with `audience`. Neither secret leaves the server. Raw ids containing `@` are rejected, so emails cannot enter. An unverifiable token yields `IDENTITY_UNLINKED`, never a guessed identity. Production refuses to start without the secret and issuer key. |
| Per-surface keys | A surface reports with `X-Surface-Key: vss1.<contract>.<surface>.<mac>`, derived from the ingest key and bound to exactly that contract and surface. A compromised surface can only report as itself; the master ingest key cannot write observations. `observationId` is namespaced by contract and surface, so one surface cannot squat another's ids. |
| Brute force | Failed authentication is throttled per client **before** any credential is compared (10 failures, then one attempt per 5 s, `429 too_many_auth_failures`). Production refuses secrets under 24 characters or with fewer than 10 distinct characters. |
| Flooding and storage | Observation quotas are charged per observation, not per request; each contract is capped (`VARIANTSHIELD_MAX_OBSERVATIONS_PER_CONTRACT`, default 500000, then `429`). Retention purges events, observations (`RETENTION_DAYS`) and findings, drift and configuration snapshots (`VARIANTSHIELD_HISTORY_RETENTION_DAYS`). `observedAt` may be at most 60 s ahead of the server clock. |
| CPU exhaustion | Report evaluation is linear in the data (it was quadratic), reports are cached for 5 s and invalidated on any change, report responses list at most 500 subjects (violations first), heavy reads are rate limited, and Flagsmith re-verification is capped at 50 lookups or 8 s. |
| Decision ledger | Append-only (database triggers refuse UPDATE and DELETE), hash-chained and HMAC-signed with a server-side key (`VARIANTSHIELD_LEDGER_KEY`). A decision is official only after a different named actor approves it with a typed confirmation and a reason; approval after the facts changed needs an explicit acknowledgement that is recorded. Verification runs online or offline (`variantshield ledger verify`). |
| Assistant and MCP | The assistant is rule-based: no model, no network, no data leaves the server, and it cannot write. The MCP server is read-only unless `VARIANTSHIELD_MCP_ALLOW_PROPOSE=true` and an admin token are set, and then it can only create a proposal. Results are marked as untrusted data, control and bidirectional characters are stripped and sizes are capped. |
| Privileged actions | Pause/resume/complete need the admin token **and** the exact typed confirmation (`PAUSE <id>`) **and** a reason, are rate limited, serialised per experiment, audited (including refusals that reach the control flow) and verified against Flagsmith afterwards. `dryRun` must be sent explicitly. Nothing runs automatically. |
| PII | Telemetry rejects personal-data fields (`email`, `name`, `ip`, `userAgent`, ...) and any `identityId` containing characters outside `[A-Za-z0-9_-:.]`. Use an opaque or hashed identifier. |
| Browser | Strict CSP (`default-src 'self'`, `base-uri`, `form-action` and `object-src` none, no inline script or style), `X-Frame-Options: DENY`, `nosniff`, `Permissions-Policy`, COOP/CORP `same-origin`, HSTS behind a trusted HTTPS proxy, no `innerHTML` in the dashboard. The token lives in `sessionStorage` of one tab. CORS is off unless `CORS_ORIGINS` lists origins. |
| SSRF / path traversal | The bench target must be `http://127.0.0.1` or `localhost`; screenshot paths are validated and confined to the run directory; the child process is spawned without a shell. |
| Supply chain | Zero runtime dependencies (Node built-ins only). Dev dependencies are TypeScript, ESLint and Playwright. |

## Known limitations

* The rate limiter is in-memory and per process; run one API instance or put a limiter in front.
* The admin token is a single shared secret; there is no per-user identity beyond the self-declared actor name in the audit log.
* The checkout demo's fault-injection endpoint is protected by a shared key and must never be exposed publicly.
* TLS is not terminated by VariantShield; put it behind a reverse proxy.

## Reverse proxies

Set `VARIANTSHIELD_TRUST_PROXY=true` only when VariantShield is reachable exclusively through a proxy you control that appends the real client address to `X-Forwarded-For`. The **last** hop is used. Without it every client behind the proxy shares one rate-limit and lockout bucket; with it enabled but exposed directly, clients can spoof their address.

## Residual risks (not eliminated)

* Removal of the **newest** ledger entries is undetectable from inside the database. Store the head hash elsewhere and check it with `--expect-head`.
* The ledger's `actor` is the name the caller sent, so a decision is attributable only as far as the admin credential is. Two people sharing one token can approve each other's proposals under two names.
* MCP output is text written by people and systems. The notice and sanitising reduce prompt-injection risk but cannot remove it; keep the token read-only.
* A leaked per-surface key still lets its holder report false observations **for that one surface**, and the latest observation per subject and surface wins. Drift records the change, but a malicious surface can still mask its own violation. Rotate the ingest key to rotate all surface keys.
* Identity tokens are bearer credentials until they expire (default 15 minutes). Keep the TTL short and send them only server to server.
* SQLite and the single request thread cap throughput; a very large estate needs a queue and Postgres (not built).
* Lockout is per client address and per credential class (admin, ingest or surface, issuer). During a lockout the correct credential is refused too, otherwise guesses would be unthrottled; behind a proxy without `VARIANTSHIELD_TRUST_PROXY` everyone shares one address, so a handful of bad requests locks everyone out for a few seconds. A determined attacker with many addresses is slowed, not stopped. Put a WAF or network allow-list in front of the admin routes.
* The admin and viewer tokens are shared secrets with no per-user identity; the audit `actor` is self-declared. Put SSO in front for real attribution.
* The compose stacks have been validated with `docker compose config` in CI but never brought up end to end.
* The demo's cookies omit `Secure` for clients on loopback over plain HTTP (WebKit refuses to store Secure cookies there, so the demo would lose its identity on every request). They are `HttpOnly` and `SameSite=Lax` always, and `Secure` for every remote client and for HTTPS via a trusted `X-Forwarded-Proto`. Do not expose the demo over plain HTTP beyond loopback.
