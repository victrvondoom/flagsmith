import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { createApp, type App } from "./app.ts";
import { buildFlagsmith } from "./context.ts";
import { sampleResultsPayload, SAMPLE_EXPERIMENT, startFakeFlagsmith, type FakeFlagsmith } from "../../../packages/flagsmith-adapter/src/testing/fake-flagsmith.ts";

process.env.VARIANTSHIELD_LOG = "off";
const ADMIN = "admin-token-for-tests-0123";
const INGEST = "ingest-key-for-tests-0123";
let fake: FakeFlagsmith;
let app: App;
let base: string;
let clock = 1_800_000_000_000;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${ADMIN}` }): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

beforeEach(async () => {
  fake = await startFakeFlagsmith({ experiments: [SAMPLE_EXPERIMENT] });
  const cfg = loadConfig({
    VARIANTSHIELD_ADMIN_TOKEN: ADMIN, VARIANTSHIELD_INGEST_KEY: INGEST, VARIANTSHIELD_DB_PATH: ":memory:", PORT: "0",
    FLAGSMITH_URL: fake.url, FLAGSMITH_ENVIRONMENT_KEY: fake.environmentKey, FLAGSMITH_ADMIN_API_KEY: fake.adminKey, CORS_ORIGINS: "http://allowed.test",
  });
  clock = 1_800_000_000_000;
  const ctx = { cfg, db: new Db(":memory:"), now: () => clock, flagsmith: buildFlagsmith(cfg) };
  app = createApp(ctx);
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => app.server.close(() => r()));
  app.ctx.db.close();
  await fake.close();
});

const linkedPlan = async (): Promise<number> => {
  const { json } = await call("POST", "/api/plans", { title: "Checkout flow", treatmentVariants: ["upi_first", "one_tap"], featureKey: "checkout_flow" });
  await call("POST", `/api/plans/${json.plan.id}/link`, { flagsmithExperimentId: 7 });
  return json.plan.id;
};

describe("api: security and plumbing", () => {
  it("integration__admin__reports_wiring_without_leaking_secret_values", async () => {
    const r = await call("GET", "/api/integration");
    assert.equal(r.status, 200);
    assert.equal(r.json.secrets.identitySecret, true);
    assert.ok(r.json.flagsmith.health);
    assert.ok(r.json.endpoints.identityIssue);
    assert.ok(!JSON.stringify(r.json).includes(ADMIN));
    assert.equal((await call("GET", "/api/integration", undefined, {})).status, 401);
  });
  it("health__is_public", async () => {
    assert.equal((await call("GET", "/health", undefined, {})).status, 200);
  });

  it("admin_routes__without_token__are_401_with_error_envelope", async () => {
    const r = await call("GET", "/api/board", undefined, {});
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, "unauthorized");
    assert.equal((await call("GET", "/api/board", undefined, { authorization: "Bearer wrong" })).status, 401);
  });

  it("ingest__admin_token_is_not_accepted_as_ingest_key", async () => {
    assert.equal((await call("POST", "/api/ingest", { events: [] }, { authorization: `Bearer ${ADMIN}` })).status, 401);
  });

  it("responses__carry_security_headers_and_request_id", async () => {
    const r = await call("GET", "/health", undefined, {});
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.ok(r.headers.get("x-request-id"));
    assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  });

  it("cors__only_configured_origins_are_allowed", async () => {
    const ok = await fetch(base + "/health", { headers: { origin: "http://allowed.test" } });
    const no = await fetch(base + "/health", { headers: { origin: "http://evil.test" } });
    assert.equal(ok.headers.get("access-control-allow-origin"), "http://allowed.test");
    assert.equal(no.headers.get("access-control-allow-origin"), null);
  });

  it("body__invalid_json__is_400", async () => {
    const res = await fetch(base + "/api/plans", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: "{nope" });
    assert.equal(res.status, 400);
  });

  it("static__path_traversal__is_not_served", async () => {
    assert.equal((await fetch(base + "/..%2f..%2fpackage.json")).status, 404);
  });

  it("readiness__reports_database_and_flagsmith", async () => {
    const r = await call("GET", "/ready", undefined, {});
    assert.equal(r.json.database, "ok");
    assert.equal(r.json.flagsmith.state, "ok");
  });
});

describe("api: telemetry ingest", () => {
  const evt = (over: Record<string, unknown> = {}) => ({
    eventId: "e1", type: "checkout_started", experimentId: "7", featureKey: "checkout_flow", variantKey: "upi_first", identityId: "u1",
    timestamp: 1_800_000_000_000 - 1000, requestId: "r1", operation: "checkout.start", outcome: "success", ...over,
  });

  it("ingest__valid_then_replayed__is_idempotent", async () => {
    const h = { "x-ingest-key": INGEST };
    assert.equal((await call("POST", "/api/ingest", { events: [evt()] }, h)).json.accepted, 1);
    assert.equal((await call("POST", "/api/ingest", { events: [evt()] }, h)).json.duplicate, 1);
    assert.equal(app.ctx.db.get("SELECT COUNT(*) AS n FROM events")?.n, 1);
  });

  it("ingest__missing_variant__is_stored_as_unattributed_never_defaulted", async () => {
    await call("POST", "/api/ingest", { events: [evt({ variantKey: undefined })] }, { "x-ingest-key": INGEST });
    const row = app.ctx.db.get("SELECT variant_key, attribution FROM events");
    assert.deepEqual([row?.variant_key, row?.attribution], [null, "missing"]);
  });

  it("ingest__pii_identity__is_rejected_and_not_stored", async () => {
    const r = await call("POST", "/api/ingest", { events: [evt({ identityId: "a@b.com" })] }, { "x-ingest-key": INGEST });
    assert.equal(r.json.rejected, 1);
    assert.equal(app.ctx.db.get("SELECT COUNT(*) AS n FROM events")?.n, 0);
  });

  it("ingest__oversized_batch__is_400", async () => {
    const r = await call("POST", "/api/ingest", { events: new Array(501).fill(evt()) }, { "x-ingest-key": INGEST });
    assert.equal(r.status, 400);
  });

  it("ingest__event_rate_limit__a_burst_beyond_the_bucket_gets_429", async () => {
    // Given a bucket of 200 requests refilling at 100/s. Sending the burst concurrently makes it independent of machine speed:
    // a sequential loop can fall behind the refill on a loaded machine and never hit the limit.
    const burst = await Promise.all(Array.from({ length: 400 }, (_, i) => call("POST", "/api/ingest", { events: [evt({ eventId: `rl-${i}` })] }, { "x-ingest-key": INGEST })));
    const limited = burst.filter((r) => r.status === 429);
    assert.ok(limited.length >= 1, "expected the burst to be throttled");
    assert.ok(burst.some((r) => r.status === 200), "expected the start of the burst to be accepted");
    assert.ok(limited.every((r) => r.headers.has("retry-after")), "429 responses carry Retry-After");
  });
});

describe("api: plans, board and verdicts against Flagsmith", () => {
  it("plans__create_validate_update_delete", async () => {
    assert.equal((await call("POST", "/api/plans", { title: "" })).status, 400);
    const c = await call("POST", "/api/plans", { title: "My Test", treatmentVariants: ["a"] });
    assert.equal(c.json.plan.key, "my-test");
    assert.equal((await call("POST", "/api/plans", { title: "My Test" })).status, 409);
    const u = await call("PATCH", `/api/plans/${c.json.plan.id}`, { owner: "sam", guardrailOverrides: { rules: { http_5xx_rate: { warnDelta: 0.001 } } } });
    assert.equal(u.json.plan.owner, "sam");
    assert.equal((await call("PATCH", `/api/plans/${c.json.plan.id}`, { guardrailOverrides: { rules: { http_5xx_rate: { warnDelta: 0.5, breachDelta: 0.1 } } } })).status, 400);
    assert.equal((await call("DELETE", `/api/plans/${c.json.plan.id}`)).status, 200);
    assert.equal((await call("GET", `/api/plans/${c.json.plan.id}`)).status, 404);
  });

  it("link__verifies_experiment_exists_in_flagsmith_first", async () => {
    const c = await call("POST", "/api/plans", { title: "Ghost" });
    assert.equal((await call("POST", `/api/plans/${c.json.plan.id}/link`, { flagsmithExperimentId: 999 })).status, 404);
    const ok = await call("POST", `/api/plans/${c.json.plan.id}/link`, { flagsmithExperimentId: 7 });
    assert.equal(ok.json.plan.lastFlagsmithStatus, "running");
  });

  it("import__creates_linked_plans_from_flagsmith_once", async () => {
    assert.equal((await call("POST", "/api/plans/import-flagsmith", {})).json.imported, 1);
    assert.equal((await call("POST", "/api/plans/import-flagsmith", {})).json.imported, 0);
  });

  it("board__reflects_live_flagsmith_status_not_stored_guess", async () => {
    const id = await linkedPlan();
    assert.equal((await call("GET", "/api/board")).json.cards[0].state, "RUNNING");
    fake.experiments.get(7)!.status = "paused";
    assert.equal((await call("GET", "/api/board")).json.cards[0].state, "PAUSED");
    assert.ok(id);
  });

  it("board__flagsmith_unreachable__marks_stale_instead_of_claiming_running", async () => {
    await linkedPlan();
    await fake.close();
    const card = (await call("GET", "/api/board")).json.cards[0];
    assert.equal(card.flagsmith.stale, true);
    assert.match(card.flagsmith.error, /network|unavailable|timeout/);
    fake = await startFakeFlagsmith();
  });

  it("verdict__uses_flagsmith_results_and_real_telemetry_separately", async () => {
    const id = await linkedPlan();
    fake.results.set(7, sampleResultsPayload());
    const r = await call("GET", `/api/plans/${id}/verdict`);
    assert.equal(r.json.provenance.experiment, "flagsmith");
    assert.equal(r.json.verdict.experimentVerdict.winner, "upi_first");
    assert.equal(r.json.verdict.outcome, "INSUFFICIENT_EVIDENCE", "no telemetry yet, so no safety claim");
  });

  it("simulation__dangerous_winner__is_labelled_and_recommends_pause", async () => {
    const run = await call("POST", "/api/simulate/dangerous-winner", {});
    assert.equal(run.status, 200);
    const id = run.json.plan.id;
    const v = (await call("GET", `/api/plans/${id}/verdict`)).json;
    assert.equal(v.provenance.experiment, "simulation-fixture");
    assert.equal(v.provenance.reliability, "simulation");
    assert.equal(v.verdict.outcome, "WINNER_BUT_UNSAFE");
    assert.equal(v.verdict.recommendedAction, "pause");
    assert.equal((await call("GET", "/api/board")).json.cards.find((c: any) => c.plan.id === id).state, "BREACH");
  });

  it("simulation__safe_winner__is_safe_and_rerun_is_repeatable", async () => {
    await call("POST", "/api/simulate/safe-winner", {});
    const second = await call("POST", "/api/simulate/safe-winner", {});
    const v = (await call("GET", `/api/plans/${second.json.plan.id}/verdict`)).json;
    assert.equal(v.verdict.outcome, "WINNER_AND_SAFE");
    assert.equal(app.ctx.db.all("SELECT 1 FROM plans WHERE key = 'sim-safe-winner'").length, 1);
  });

  it("simulation__data_never_leaks_into_real_source", async () => {
    const run = await call("POST", "/api/simulate/dangerous-winner", {});
    const real = (await call("GET", `/api/plans/${run.json.plan.id}/reliability?source=real`)).json.report;
    assert.ok(real.variants.every((v: any) => v.status === "INSUFFICIENT_DATA"));
  });

  it("timeline__simulation__shows_the_regression_in_the_latest_bucket_with_threshold_lines", async () => {
    const run = await call("POST", "/api/simulate/dangerous-winner", {});
    const t = (await call("GET", `/api/plans/${run.json.plan.id}/timeline`)).json.timeline;
    assert.equal(t.points.length, 12);
    assert.equal(t.variants[0], "control", "baseline first");
    assert.ok(t.variants.includes("upi_first") && t.variants.includes("one_tap"));
    const rates = t.points.map((p: any) => p.variants.upi_first?.paymentFailureRate).filter((x: number | null | undefined) => x != null);
    assert.ok(rates.length >= 2 && Math.max(...rates) > t.thresholds.payment_failure_rate.breach, "a bucket exceeds the breach line");
    assert.ok(Math.min(...rates) < t.thresholds.payment_failure_rate.warn, "the earlier healthy window is under the warn line");
    assert.equal((await call("GET", `/api/plans/${run.json.plan.id}/timeline?source=bogus`)).status, 400);
  });

  it("evidence__snapshot_is_persisted_and_retrievable", async () => {
    const run = await call("POST", "/api/simulate/dangerous-winner", {});
    const e = await call("POST", `/api/plans/${run.json.plan.id}/evidence`, {});
    const got = await call("GET", `/api/evidence/${e.json.id}`);
    assert.equal(got.json.payload.verdict.outcome, "WINNER_BUT_UNSAFE");
    assert.equal(got.json.payload.simulated, true);
  });
});

describe("api: human-approved experiment control", () => {
  const act = (planId: number, over: Record<string, unknown> = {}) => call("POST", "/api/control", { planId, action: "pause", dryRun: false, confirmation: "PAUSE 7", reason: "Payment failures breached guardrail", ...over });

  it("dryRun__reports_plan_and_changes_nothing", async () => {
    const id = await linkedPlan();
    const r = await act(id, { dryRun: true });
    assert.equal(r.json.outcome, "dry_run");
    assert.equal(fake.experiments.get(7)!.status, "running");
    assert.ok(!fake.calls.some((c) => c.path.endsWith("/pause/")));
  });

  it("pause__with_confirmation__calls_flagsmith_and_verifies_new_state", async () => {
    const id = await linkedPlan();
    const r = await act(id);
    assert.deepEqual([r.status, r.json.before, r.json.after], [200, "running", "paused"]);
    assert.equal(fake.experiments.get(7)!.status, "paused");
    const audit = (await call("GET", "/api/audit")).json.audit[0];
    assert.deepEqual([audit.outcome, audit.before_state, audit.after_state, audit.dry_run], ["executed", "running", "paused", 0]);
  });

  it("pause__wrong_confirmation_text__is_rejected_before_any_flagsmith_call", async () => {
    const id = await linkedPlan();
    const r = await act(id, { confirmation: "pause" });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, "confirmation_required");
    assert.ok(!fake.calls.some((c) => c.path.endsWith("/pause/")));
  });

  it("pause__missing_reason__is_rejected", async () => {
    const id = await linkedPlan();
    assert.equal((await act(id, { reason: "short" })).json.error.code, "reason_required");
  });

  it("pause__dryRun_not_explicit__is_400_so_nothing_executes_by_accident", async () => {
    const id = await linkedPlan();
    assert.equal((await call("POST", "/api/control", { planId: id, action: "pause", confirmation: "PAUSE 7", reason: "long enough reason" })).status, 400);
  });

  it("pause__already_paused__is_409_invalid_transition", async () => {
    const id = await linkedPlan();
    await act(id);
    const again = await act(id);
    assert.equal(again.status, 409);
    assert.equal(again.json.error.code, "invalid_transition");
  });

  it("pause__flagsmith_says_ok_but_state_unchanged__is_verification_failed", async () => {
    const id = await linkedPlan();
    fake.ignoreNextTransition();
    const r = await act(id);
    assert.equal(r.status, 502);
    assert.equal(r.json.error.code, "verification_failed");
    assert.equal((await call("GET", "/api/audit")).json.audit[0].outcome, "verification_failed");
  });

  it("pause__insufficient_flagsmith_permission__is_403_with_clear_message_and_audited", async () => {
    const id = await linkedPlan();
    fake.failNext("/pause/", 403, 1);
    const r = await act(id);
    assert.equal(r.status, 403);
    assert.match(r.json.error.message, /lacks permission/);
    assert.equal((await call("GET", "/api/audit")).json.audit[0].outcome, "flagsmith_call_failed");
  });

  it("pause__without_admin_token__is_401_and_nothing_happens", async () => {
    const id = await linkedPlan();
    assert.equal((await call("POST", "/api/control", { planId: id, action: "pause", dryRun: false, confirmation: "PAUSE 7", reason: "long enough reason" }, {})).status, 401);
    assert.equal(fake.experiments.get(7)!.status, "running");
  });

  it("resume_and_complete__follow_documented_transitions", async () => {
    const id = await linkedPlan();
    await act(id);
    assert.equal((await act(id, { action: "resume", confirmation: "RESUME 7" })).json.after, "running");
    assert.equal((await act(id, { action: "complete", confirmation: "COMPLETE 7" })).json.after, "completed");
    assert.equal((await act(id, { action: "resume", confirmation: "RESUME 7" })).status, 409);
  });

  it("simulated_pause__never_calls_flagsmith_and_is_audited_as_simulated", async () => {
    const run = await call("POST", "/api/simulate/dangerous-winner", {});
    const id = run.json.plan.id;
    const before = fake.calls.length;
    const r = await call("POST", "/api/control", { planId: id, action: "pause", dryRun: false, confirmation: "PAUSE sim-dangerous-winner", reason: "Simulated breach on payment failures" });
    assert.equal(r.json.simulated, true);
    assert.equal(fake.calls.length, before);
    assert.equal((await call("GET", "/api/audit")).json.audit[0].simulated, 1);
    assert.equal((await call("GET", "/api/board")).json.cards.find((c: any) => c.plan.id === id).state, "PAUSED");
  });

  it("controls__are_rate_limited", async () => {
    const id = await linkedPlan();
    let limited = false;
    for (let i = 0; i < 14 && !limited; i++) limited = (await act(id, { dryRun: true })).status === 429;
    assert.ok(limited);
  });
});
