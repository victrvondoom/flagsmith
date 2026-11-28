import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../apps/api/src/config.ts";
import { Db } from "../apps/api/src/db.ts";
import { createApp, type App } from "../apps/api/src/app.ts";
import { buildFlagsmith } from "../apps/api/src/context.ts";
import { createDemoApp, type DemoApp } from "../apps/checkout-demo/src/server.ts";
import { createTelemetry } from "../apps/checkout-demo/src/instrument.ts";
import { FlagsmithClient } from "../packages/flagsmith-adapter/src/index.ts";
import { sampleResultsPayload, SAMPLE_EXPERIMENT, startFakeFlagsmith, type FakeFlagsmith } from "../packages/flagsmith-adapter/src/testing/fake-flagsmith.ts";
import { mulberry32 } from "../packages/guardrail-engine/src/fixtures.ts";
import { runTraffic } from "../scripts/traffic.ts";

process.env.VARIANTSHIELD_LOG = "off";
const ADMIN = "e2e-admin-token-0123456";
const INGEST = "e2e-ingest-key-0123456";
const DEMO_KEY = "e2e-demo-key-0123456";
const clock = { t: 1_800_000_000_000 };
let fake: FakeFlagsmith, api: App, demo: DemoApp, apiUrl: string, demoUrl: string, flush: () => Promise<void>;

const admin = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(apiUrl + path, { method, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const listen = (s: { listen: (p: number, h: string, cb: () => void) => void; address: () => unknown }): Promise<string> =>
  new Promise((res) => s.listen(0, "127.0.0.1", () => res(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

beforeEach(async () => {
  clock.t = 1_800_000_000_000;
  fake = await startFakeFlagsmith({ experiments: [SAMPLE_EXPERIMENT] });
  const cfg = loadConfig({ VARIANTSHIELD_ADMIN_TOKEN: ADMIN, VARIANTSHIELD_INGEST_KEY: INGEST, VARIANTSHIELD_DB_PATH: ":memory:", PORT: "0", FLAGSMITH_URL: fake.url, FLAGSMITH_ENVIRONMENT_KEY: fake.environmentKey, FLAGSMITH_ADMIN_API_KEY: fake.adminKey });
  api = createApp({ cfg, db: new Db(":memory:"), now: () => clock.t, flagsmith: buildFlagsmith(cfg) });
  apiUrl = await listen(api.server);
  const telemetry = createTelemetry({ url: apiUrl, ingestKey: INGEST, experimentId: "7", featureKey: "checkout_flow", now: () => clock.t, onError: (e) => { throw e; } });
  flush = () => telemetry.flush();
  demo = createDemoApp({
    flagsmith: new FlagsmithClient({ baseUrl: fake.url, environmentKey: fake.environmentKey }), telemetry,
    cfg: { featureKey: "checkout_flow", latencyScale: 0.002, allowOverride: false, allowUidHeader: true, controlKey: DEMO_KEY, now: () => clock.t, random: mulberry32(7) },
  });
  demoUrl = await listen(demo.server);
});
afterEach(async () => {
  await new Promise<void>((r) => demo.server.close(() => r()));
  await new Promise<void>((r) => api.server.close(() => r()));
  api.ctx.db.close();
  await fake.close();
});

const wave = async (prefix: string, users: number): Promise<void> => {
  await runTraffic({ baseUrl: demoUrl, users, uidPrefix: prefix, random: mulberry32(users + prefix.length) });
  await flush();
};

describe("end to end: Flagsmith (contract double) -> checkout demo -> telemetry -> verdict -> human-approved pause", () => {
  it("safe_then_dangerous_winner__is_detected_and_pausable_after_human_confirmation", async () => {
    // Plan imported from Flagsmith's experiment list, with demo-scale sample floors for the 5xx metric.
    // Latency is deliberately loosened here: the demo's simulated latency is ~1 ms, so measured p95 is dominated by event-loop
    // scheduling noise and would make this test depend on runner speed. Latency regressions are covered by the engine tests and the bench.
    assert.equal((await admin("POST", "/api/plans/import-flagsmith", {})).json.imported, 1);
    const plan = (await admin("GET", "/api/plans")).json.plans[0];
    assert.equal(plan.flagsmithExperimentId, 7);
    await admin("PATCH", `/api/plans/${plan.id}`, { key: "7", guardrailOverrides: { rules: { http_5xx_rate: { minDenominator: 150 }, checkout_p95_latency_ms: { warnRatio: 8, breachRatio: 10, minSamples: 100 } } } });
    fake.results.set(7, sampleResultsPayload());

    // Phase 1: healthy traffic. Flagsmith serves variants; the demo exposes and converts through Flagsmith.
    await wave("healthy", 2400);
    assert.ok(fake.events.some((e) => e.event === "$flag_exposure"), "exposures reached Flagsmith");
    assert.ok(fake.events.some((e) => e.event === "checkout_completed"), "conversions reached Flagsmith");
    let v = (await admin("GET", `/api/plans/${plan.id}/verdict`)).json;
    assert.equal(v.provenance.experiment, "flagsmith");
    assert.equal(v.verdict.experimentVerdict.winner, "upi_first");
    assert.equal(v.verdict.outcome, "WINNER_AND_SAFE", JSON.stringify(v.verdict.evidence.slice(0, 6)));
    assert.equal((await admin("GET", "/api/board")).json.cards[0].state, "RUNNING");

    // Phase 2: a later window; upi_first starts failing payments while still winning on conversion.
    clock.t += 16 * 60_000;
    assert.equal((await fetch(`${demoUrl}/__fault`, { method: "POST", headers: { "x-demo-key": DEMO_KEY }, body: JSON.stringify({ variant: "upi_first", type: "payment_failures", rate: 0.12 }) })).status, 200);
    await wave("faulty", 2400);
    v = (await admin("GET", `/api/plans/${plan.id}/verdict`)).json;
    assert.equal(v.verdict.experimentVerdict.winner, "upi_first", "Flagsmith still calls upi_first the conversion winner");
    assert.equal(v.verdict.outcome, "WINNER_BUT_UNSAFE", JSON.stringify(v.verdict.evidence.slice(0, 6)));
    assert.equal(v.verdict.recommendedAction, "pause");
    assert.ok(v.verdict.evidence.some((l: string) => /\[upi_first\] payment_failure_rate: BREACH/.test(l)));
    assert.equal((await admin("GET", "/api/board")).json.cards[0].state, "BREACH");
    const ev = await admin("POST", `/api/plans/${plan.id}/evidence`, {});

    // Human approval: dry run, then the exact typed confirmation, then Flagsmith confirms the new state.
    const dry = await admin("POST", "/api/control", { planId: plan.id, action: "pause", dryRun: true });
    assert.equal(dry.json.outcome, "dry_run");
    assert.equal(fake.experiments.get(7)!.status, "running");
    const done = await admin("POST", "/api/control", { planId: plan.id, action: "pause", dryRun: false, confirmation: "PAUSE 7", reason: "payment_failure_rate breached on upi_first", evidenceId: ev.json.id });
    assert.deepEqual([done.json.before, done.json.after], ["running", "paused"]);
    assert.equal(fake.experiments.get(7)!.status, "paused");
    assert.equal((await admin("GET", "/api/board")).json.cards[0].state, "PAUSED");
    const audit = (await admin("GET", "/api/audit")).json.audit;
    assert.deepEqual(audit.map((a: any) => a.outcome).slice(0, 2), ["executed", "dry_run"]);
    assert.equal(audit[0].evidence_id, ev.json.id);
  });

  it("unattributed_sessions__flagsmith_outage_during_traffic__are_counted_not_blamed_on_a_variant", async () => {
    await admin("POST", "/api/plans/import-flagsmith", {});
    const plan = (await admin("GET", "/api/plans")).json.plans[0];
    await admin("PATCH", `/api/plans/${plan.id}`, { key: "7" });
    await fake.close();
    const stats = await runTraffic({ baseUrl: demoUrl, users: 60, uidPrefix: "outage", random: mulberry32(3) });
    await flush();
    assert.equal(stats.unassigned, 60);
    const summary = (await admin("GET", "/api/events/summary?source=real")).json;
    const attribution = Object.fromEntries(summary.byAttribution.map((r: any) => [r.attribution, r.n]));
    assert.ok(attribution.missing > 0 && !attribution.valid);
    fake = await startFakeFlagsmith();
  });
});
