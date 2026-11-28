import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { createApp, type App } from "./app.ts";
import { EXAMPLE_MANIFEST } from "./contract-sim.ts";
import { deriveSurfaceKey, verifySurfaceKey } from "./surface-keys.ts";
import { RateLimiter } from "../../../packages/telemetry/src/index.ts";
import { issueIdentityToken, verifyIdentityToken } from "../../../packages/contracts/src/index.ts";

process.env.VARIANTSHIELD_LOG = "off";
const ADMIN = "admin-token-for-tests-0123", VIEWER = "viewer-token-for-tests-0123", INGEST = "ingest-key-for-tests-0123", ISSUER = "issuer-key-for-tests-0123", SECRET = "identity-secret-for-tests-0123456789";
let app: App, base: string, clock = 1_800_000_000_000;

const env = (extra: Record<string, string> = {}): Record<string, string> => ({ VARIANTSHIELD_ADMIN_TOKEN: ADMIN, VARIANTSHIELD_VIEWER_TOKEN: VIEWER, VARIANTSHIELD_INGEST_KEY: INGEST, VARIANTSHIELD_IDENTITY_ISSUER_KEY: ISSUER, VARIANTSHIELD_IDENTITY_SECRET: SECRET, VARIANTSHIELD_DB_PATH: ":memory:", PORT: "0", ...extra });
async function start(extra: Record<string, string> = {}): Promise<void> {
  const cfg = loadConfig(env(extra));
  clock = 1_800_000_000_000;
  app = createApp({ cfg, db: new Db(":memory:"), now: () => clock, flagsmith: null });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${ADMIN}` }) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: text && text.startsWith("{") ? JSON.parse(text) : null };
}
const manifest = (): any => parseYaml(readFileSync(EXAMPLE_MANIFEST, "utf8"));
const surfaceCall = (surfaceId: string, observations: unknown, contractId = "checkout-journey") =>
  call("POST", "/api/contract-observations", { observations }, { "x-surface-key": deriveSurfaceKey(INGEST, contractId, surfaceId) });
const obs = (surfaceId: string, id: string, extra: Record<string, unknown> = {}) => ({
  observationId: id, contractId: "checkout-journey", contractVersion: 1, experimentKey: "checkout_journey", environment: "production", envFingerprint: "aaaaaaaaaaaaaaaa",
  assignmentFlag: "checkout_journey_variant", assignedVariant: "control", surfaceId, identityToken: "x", observedAt: clock - 1000, features: { checkout_ui: "classic" }, ...extra,
});

afterEach(async () => { await new Promise<void>((r) => app.server.close(() => r())); app.ctx.db.close(); });

describe("security: authentication abuse", () => {
  beforeEach(() => start());

  it("auth__repeated_wrong_admin_tokens__lock_the_client_out_with_429_and_retry_after", async () => {
    // Given 10 failed attempts (the allowance)
    for (let i = 0; i < 10; i++) assert.equal((await call("GET", "/api/board", undefined, { authorization: `Bearer wrong-${i}` })).status, 401);
    // When another attempt is made, even with the correct token
    const locked = await call("GET", "/api/board");
    // Then it is refused until the allowance refills
    assert.equal(locked.status, 429);
    assert.equal(locked.json.error.code, "too_many_auth_failures");
    assert.ok(Number(locked.headers.get("retry-after")) >= 1);
  });

  it("auth__failed_surface_keys__do_not_lock_the_admin_out", async () => {
    for (let i = 0; i < 11; i++) await call("POST", "/api/identity/verify", { token: "x" }, { "x-surface-key": "vss1.a.b.wrong" });
    assert.equal((await call("POST", "/api/identity/verify", { token: "x" }, { "x-ingest-key": "wrong" })).status, 429);
    assert.equal((await call("GET", "/api/board")).status, 200);
  });

  it("auth__lockout_is_per_client_when_the_proxy_is_trusted", async () => {
    await app.server.close(); app.ctx.db.close();
    await start({ VARIANTSHIELD_TRUST_PROXY: "true" });
    for (let i = 0; i < 10; i++) await call("GET", "/api/board", undefined, { authorization: "Bearer wrong", "x-forwarded-for": "203.0.113.9" });
    assert.equal((await call("GET", "/api/board", undefined, { authorization: `Bearer ${ADMIN}`, "x-forwarded-for": "203.0.113.9" })).status, 429);
    assert.equal((await call("GET", "/api/board", undefined, { authorization: `Bearer ${ADMIN}`, "x-forwarded-for": "198.51.100.7" })).status, 200);
  });

  it("limiter__peek__does_not_consume_tokens", () => {
    const l = new RateLimiter({ capacity: 2, refillPerSecond: 1 });
    assert.equal(l.peek("k", 0), 0);
    l.take("k", 0); l.take("k", 0);
    assert.ok(l.peek("k", 0) > 0);
    assert.equal(l.peek("k", 1500), 0);
    assert.equal(l.take("k", 1500), 0);
  });

  it("config__production__rejects_weak_or_patterned_secrets", () => {
    const prod = (over: Record<string, string>) => () => loadConfig({ ...env(), NODE_ENV: "production", ...over });
    assert.throws(prod({ VARIANTSHIELD_ADMIN_TOKEN: "a".repeat(32) }), /too weak/);
    assert.throws(prod({ VARIANTSHIELD_INGEST_KEY: "short-but-sixteen-ok" }), /too weak/);
    const strong = { VARIANTSHIELD_ADMIN_TOKEN: "Zk3vQ8mT1xR7pL2wN9cB5yHd4sFgJ6aE", VARIANTSHIELD_INGEST_KEY: "Qm8Lr2Xv5Tn1Wb7Pc4Hd9Ks3Fy6Jg0Ae", VARIANTSHIELD_IDENTITY_SECRET: "Rt5Yu8Io1Pl4Kj7Hg2Fd9Sa3Qw6Ez0Xc", VARIANTSHIELD_IDENTITY_ISSUER_KEY: "Vb4Nm7Ac1Sd5Fg9Hj3Kl6Qw2Er8Ty0Ui" };
    assert.doesNotThrow(() => loadConfig({ ...env(), NODE_ENV: "production", ...strong }));
  });
});

describe("security: per-surface keys and observation abuse", () => {
  beforeEach(async () => { await start(); assert.equal((await call("POST", "/api/contracts", manifest())).status, 200); });

  it("surface_key__derivation__is_bound_to_contract_and_surface_and_tamper_evident", () => {
    const k = deriveSurfaceKey(INGEST, "checkout-journey", "payment-api");
    assert.deepEqual(verifySurfaceKey(INGEST, k), { contractId: "checkout-journey", surfaceId: "payment-api" });
    assert.equal(verifySurfaceKey(INGEST, k.replace("payment-api", "risk-engine")), null);
    assert.equal(verifySurfaceKey("another-ingest-key-0123456789", k), null);
    assert.equal(verifySurfaceKey(INGEST, "vss1.a.b"), null);
    assert.equal(verifySurfaceKey(INGEST, undefined), null);
  });

  it("observations__master_ingest_key__is_rejected_and_cannot_write", async () => {
    const r = await call("POST", "/api/contract-observations", { observations: [obs("payment-api", "master-attempt-1")] }, { "x-ingest-key": INGEST });
    assert.equal(r.status, 401);
    assert.equal(app.ctx.db.get("SELECT COUNT(*) AS n FROM contract_observations")?.n, 0);
  });

  it("observations__a_surface_key__cannot_report_as_another_surface_or_contract", async () => {
    // Given the web surface's key, When it claims to be the payment API
    const r = await surfaceCall("web-checkout", [obs("payment-api", "spoof-payment-1")]);
    // Then the record is rejected with the binding reason and nothing is stored
    assert.equal(r.json.rejected, 1);
    assert.match(JSON.stringify(r.json.results), /may only report as checkout-journey\/web-checkout/);
    const other = await surfaceCall("web-checkout", [obs("web-checkout", "spoof-contract-1", { contractId: "sim-checkout-journey" })]);
    assert.equal(other.json.rejected, 1);
    assert.equal(app.ctx.db.get("SELECT COUNT(*) AS n FROM contract_observations")?.n, 0);
  });

  it("observations__same_observation_id_from_two_surfaces__does_not_collide", async () => {
    const a = await surfaceCall("web-checkout", [obs("web-checkout", "shared-id-0001")]);
    const b = await surfaceCall("payment-api", [obs("payment-api", "shared-id-0001", { features: { payment_route: "legacy" } })]);
    assert.equal(a.json.accepted, 1);
    assert.equal(b.json.accepted, 1);
  });

  it("observations__future_timestamps_beyond_the_skew_allowance__are_rejected", async () => {
    const ok = await surfaceCall("web-checkout", [obs("web-checkout", "skew-ok-00001", { observedAt: clock + 30_000 })]);
    const bad = await surfaceCall("web-checkout", [obs("web-checkout", "skew-bad-0001", { observedAt: clock + 90_000 })]);
    assert.equal(ok.json.accepted, 1);
    assert.match(JSON.stringify(bad.json.results), /in the future/);
  });

  it("observations__batches__are_charged_per_observation_so_batching_cannot_bypass_the_limit", async () => {
    // Given a capacity of 2000 observations per surface, When 12 batches of 200 are sent quickly
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const batch = Array.from({ length: 200 }, (_, k) => obs("web-checkout", `flood-${i}-${k}-aaaa`));
      if ((await surfaceCall("web-checkout", batch)).status === 429) limited++;
    }
    // Then the later batches are throttled
    assert.ok(limited >= 1, "expected at least one 429");
  });

  it("observations__storage_quota__rejects_ingest_once_a_contract_is_full", async () => {
    await app.server.close(); app.ctx.db.close();
    await start({ VARIANTSHIELD_MAX_OBSERVATIONS_PER_CONTRACT: "1000" });
    await call("POST", "/api/contracts", manifest());
    for (let i = 0; i < 5; i++) await surfaceCall("web-checkout", Array.from({ length: 200 }, (_, k) => obs("web-checkout", `quota-${i}-${k}-aaaa`)));
    const over = await surfaceCall("web-checkout", [obs("web-checkout", "quota-over-0001")]);
    assert.equal(over.status, 429);
    assert.equal(over.json.error.code, "observation_quota_exceeded");
  });

  it("surface_keys__listing__is_admin_only_and_keys_verify", async () => {
    const admin = await call("GET", "/api/contracts/checkout-journey/surface-keys");
    assert.equal(admin.status, 200);
    assert.equal(admin.json.keys.length, 4);
    for (const k of admin.json.keys) assert.deepEqual(verifySurfaceKey(INGEST, k.key), { contractId: "checkout-journey", surfaceId: k.surfaceId });
    assert.equal((await call("GET", "/api/contracts/checkout-journey/surface-keys", undefined, { authorization: `Bearer ${VIEWER}` })).status, 403);
    assert.equal((await call("GET", "/api/contracts/checkout-journey/surface-keys", undefined, {})).status, 401);
  });
});

describe("security: identity tokens", () => {
  beforeEach(async () => { await start(); await call("POST", "/api/contracts", manifest()); });
  const issue = async (extra: Record<string, unknown> = {}) => (await call("POST", "/api/identity/issue", { subject: "cust-77", ...extra }, { "x-identity-issuer-key": ISSUER })).json;

  it("tokens__are_scoped_to_a_contract_when_an_audience_is_given", async () => {
    const t = await issue({ audience: "another-contract" });
    const verify = await call("POST", "/api/identity/verify", { token: t.token, audience: "checkout-journey" }, { "x-ingest-key": INGEST });
    assert.equal(verify.json.valid, false);
    assert.equal(verify.json.reason, "wrong_audience");
    const r = await surfaceCall("web-checkout", [obs("web-checkout", "aud-obs-00001", { identityToken: t.token })]);
    assert.equal(r.json.unlinked, 1);
    const own = await issue({ audience: "checkout-journey" });
    assert.equal((await call("POST", "/api/identity/verify", { token: own.token, audience: "checkout-journey" }, { "x-ingest-key": INGEST })).json.valid, true);
    assert.equal((await call("POST", "/api/identity/issue", { subject: "cust-77", audience: "Bad Audience!" }, { "x-identity-issuer-key": ISSUER })).status, 400);
  });

  it("tokens__carry_a_unique_jti_so_two_issues_differ", async () => {
    const a = await issue(), b = await issue();
    assert.notEqual(a.token, b.token);
    assert.equal(a.subjectRef, b.subjectRef);
  });

  it("tokens__signing_key_rotates_without_changing_subject_refs_or_invalidating_live_tokens", () => {
    const oldKey = "old-token-signing-key-0123456789", newKey = "new-token-signing-key-0123456789";
    const t = issueIdentityToken(oldKey, "sub_" + "a".repeat(32), "authenticated", clock, 600);
    assert.equal(verifyIdentityToken([newKey], t, clock).ok, false);
    assert.equal(verifyIdentityToken([newKey, oldKey], t, clock).ok, true);
  });

  it("tokens__token_key_is_independent_of_the_pseudonym_secret", () => {
    const a = loadConfig(env({ VARIANTSHIELD_IDENTITY_TOKEN_SECRET: "token-key-number-one-0123456789" }));
    const b = loadConfig(env({ VARIANTSHIELD_IDENTITY_TOKEN_SECRET: "token-key-number-two-0123456789" }));
    assert.equal(a.identitySecret, b.identitySecret);
    assert.notEqual(a.identityTokenSecret, b.identityTokenSecret);
  });

  it("tokens__oversized_input__is_rejected_as_malformed", () => {
    assert.deepEqual(verifyIdentityToken("k".repeat(20), "vsid1." + "a".repeat(5000) + ".x", clock), { ok: false, reason: "malformed" });
  });
});

describe("security: roles, headers, metrics, retention, caching", () => {
  beforeEach(async () => { await start(); await call("POST", "/api/contracts", manifest()); });

  it("viewer__can_read_but_not_change_state", async () => {
    const asViewer = { authorization: `Bearer ${VIEWER}` };
    assert.equal((await call("GET", "/api/contracts", undefined, asViewer)).status, 200);
    assert.equal((await call("POST", "/api/contracts", manifest(), asViewer)).status, 403);
    assert.equal((await call("POST", "/api/contracts/checkout-journey/check", undefined, asViewer)).status, 403);
    assert.equal((await call("POST", "/api/control", {}, asViewer)).status, 403);
    assert.equal((await call("GET", "/api/contracts", undefined, { authorization: "Bearer nope" })).status, 401);
  });

  it("headers__responses_carry_the_hardened_security_headers", async () => {
    const r = await call("GET", "/health", undefined, {});
    const csp = r.headers.get("content-security-policy") ?? "";
    for (const d of ["base-uri 'none'", "form-action 'none'", "object-src 'none'", "frame-ancestors 'none'"]) assert.ok(csp.includes(d), d);
    assert.ok((r.headers.get("permissions-policy") ?? "").includes("camera=()"));
    assert.equal(r.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(r.headers.get("strict-transport-security"), null);
  });

  it("headers__hsts_is_sent_only_behind_a_trusted_https_proxy", async () => {
    await app.server.close(); app.ctx.db.close();
    await start({ VARIANTSHIELD_TRUST_PROXY: "true" });
    const r = await call("GET", "/health", undefined, { "x-forwarded-proto": "https" });
    assert.match(r.headers.get("strict-transport-security") ?? "", /max-age=31536000/);
  });

  it("metrics__requires_a_credential_and_exposes_counters", async () => {
    assert.equal((await call("GET", "/metrics", undefined, {})).status, 401);
    await call("GET", "/health", undefined, {});
    const m = await call("GET", "/metrics", undefined, { authorization: `Bearer ${VIEWER}` });
    assert.equal(m.status, 200);
    assert.match(m.text, /variantshield_http_requests_total\{status="2xx"\} \d+/);
    assert.match(m.text, /variantshield_event_loop_delay_p99_seconds /);
    assert.match(m.text, /variantshield_contract_observations_stored \d+/);
  });

  it("integration__reports_new_secrets_and_limits_without_values", async () => {
    const r = await call("GET", "/api/integration");
    assert.equal(r.json.secrets.viewerToken, true);
    assert.equal(r.json.secrets.identityTokenSecret, true);
    assert.equal(r.json.limits.maxObservationsPerContract, 500000);
    for (const secret of [ADMIN, VIEWER, INGEST, ISSUER, SECRET]) assert.ok(!r.text.includes(secret));
  });

  it("retention__purge__removes_old_observations_and_history_but_keeps_recent_rows", () => {
    const db = app.ctx.db;
    const ins = (id: string, at: number) => db.run("INSERT INTO contract_observations (observation_id, payload_hash, contract_id, contract_version, experiment_key, environment, assignment_flag, surface_id, identity_status, observed_at, received_at, features, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", id, "h", "checkout-journey", 1, "k", "production", "f", "web-checkout", "unlinked", at, at, "{}", "real");
    ins("old", 1000); ins("new", 9_000_000);
    db.run("INSERT INTO contract_drift (dedupe_key, contract_id, previous_version, current_version, attribute, previous_value, current_value, severity, affected_surfaces, message, evidence, detected_at, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", "old-drift", "checkout-journey", 1, 1, "a", "x", "y", "info", "[]", "m", "{}", 500, "real");
    const removed = db.purgeContractData(5_000_000, 5_000_000);
    assert.equal(removed.contract_observations, 1);
    assert.equal(removed.contract_drift, 1);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM contract_observations")?.n, 1);
  });

  it("report__cache__is_invalidated_by_new_observations_within_the_ttl", async () => {
    const first = await call("GET", "/api/contracts/checkout-journey/report");
    assert.equal(first.json.report.linkedObservations + first.json.report.unlinkedObservations, 0);
    const id = (await call("POST", "/api/identity/issue", { subject: "cust-cache" }, { "x-identity-issuer-key": ISSUER })).json;
    await surfaceCall("web-checkout", [obs("web-checkout", "cache-obs-0001", { identityToken: id.token })]);
    const second = await call("GET", "/api/contracts/checkout-journey/report");
    assert.equal(second.json.report.linkedObservations, 1);
  });

  it("report__heavy_endpoints__are_rate_limited_per_client", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 45; i++) statuses.push((await call("GET", "/api/contracts/checkout-journey/report")).status);
    assert.ok(statuses.includes(429), `expected a 429 in ${statuses.join(",")}`);
  });

  it("report__large_data_set__stays_within_a_bounded_time_and_second_read_is_cached", async () => {
    const db = app.ctx.db;
    db.tx(() => { for (let i = 0; i < 20_000; i++) db.run("INSERT INTO contract_observations (observation_id, payload_hash, contract_id, contract_version, experiment_key, environment, assignment_flag, surface_id, identity_status, observed_at, received_at, features, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", `checkout-journey|web-checkout|bulk-${i}`, "h", "checkout-journey", 1, "checkout_journey", "production", "checkout_journey_variant", "web-checkout", "unlinked", clock - 1000, clock, "{}", "real"); });
    const t0 = Date.now(); const a = await call("GET", "/api/contracts/checkout-journey/report"); const cold = Date.now() - t0;
    const t1 = Date.now(); const b = await call("GET", "/api/contracts/checkout-journey/report"); const warm = Date.now() - t1;
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.ok(cold < 3000, `cold report took ${cold} ms`);
    assert.ok(warm <= cold, `warm ${warm} ms should not exceed cold ${cold} ms`);
  });
});
