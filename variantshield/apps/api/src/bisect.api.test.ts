import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { createApp, type App } from "./app.ts";
import { buildFlagsmith } from "./context.ts";
import { startFakeFlagsmith, type FakeFlagsmith } from "../../../packages/flagsmith-adapter/src/testing/fake-flagsmith.ts";
import { mulberry32 } from "../../../packages/bisect/src/simulate.ts";

process.env.VARIANTSHIELD_LOG = "off";
const ADMIN = "admin-token-for-tests-0123", INGEST = "ingest-key-for-tests-0123", HOOK = "webhook-secret-for-tests-0123";
let app: App, base: string, clock = 1_800_000_000_000, fake: FakeFlagsmith | null = null;

async function start(withFlagsmith = false): Promise<void> {
  clock = 1_800_000_000_000;
  const env: Record<string, string> = { VARIANTSHIELD_ADMIN_TOKEN: ADMIN, VARIANTSHIELD_INGEST_KEY: INGEST, VARIANTSHIELD_IDENTITY_ISSUER_KEY: "issuer-key-for-tests-0123", VARIANTSHIELD_IDENTITY_SECRET: "identity-secret-for-tests-0123456789", VARIANTSHIELD_DB_PATH: ":memory:", VARIANTSHIELD_FLAGSMITH_WEBHOOK_SECRET: HOOK, PORT: "0" };
  if (withFlagsmith) {
    fake = await startFakeFlagsmith({ flags: { search_reranker: { enabled: true, value: "bm25" }, fast_checkout: { enabled: false, value: null }, new_tax_engine: { enabled: false, value: null }, promo_banner: { enabled: true, value: "diwali" } } });
    Object.assign(env, { FLAGSMITH_URL: fake.url, FLAGSMITH_ENVIRONMENT_KEY: fake.environmentKey, FLAGSMITH_ADMIN_API_KEY: fake.adminKey });
  }
  const cfg = loadConfig(env);
  app = createApp({ cfg, db: new Db(":memory:"), now: () => clock, flagsmith: buildFlagsmith(cfg) });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}
const as = (actor: string): Record<string, string> => ({ authorization: `Bearer ${ADMIN}`, "x-variantshield-actor": actor });
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = as("alice")) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const runtime = () => app.ctx.bisect!;
async function ticksUntil(pred: () => boolean, max: number, each?: () => Promise<void>): Promise<number> {
  for (let i = 0; i < max; i++) { if (pred()) return i; if (each) await each(); await runtime().tick(); }
  assert.fail(`condition not reached in ${max} ticks; incidents: ${JSON.stringify(runtime().list())}`);
}
const stateOf = (id: number) => (runtime().load(id)).state;
const latestId = (): number => Number((runtime().list()[0] as { id: number } | undefined)?.id ?? 0);

afterEach(async () => { runtime().stop(); await new Promise<void>((r) => app.server.close(() => r())); app.ctx.db.close(); if (fake) { await fake.close(); fake = null; } });

describe("incident swarm: simulation", () => {
  it("interaction__pair_of_changes__is_isolated_confirmed_and_remediated_with_two_people", async () => {
    await start();
    const sim = await call("POST", "/api/incidents/simulate", { scenario: "interaction" });
    assert.equal(sim.status, 200);
    await ticksUntil(() => latestId() > 0 && stateOf(latestId()) === "AWAITING_APPROVAL", 200);
    const id = latestId();
    const v = (await call("GET", `/api/incidents/${id}`)).json.incident;
    assert.equal(v.suspects.length, 7);
    assert.ok(v.onsetAt > 0 && v.regressionRate > v.baselineRate * 3);
    // Nothing touches flags before a person approves.
    assert.equal((await call("POST", `/api/incidents/${id}/envelope`, { confirmation: "BISECT 999", reason: "go ahead" })).status, 400);
    assert.equal((await call("POST", `/api/incidents/${id}/envelope`, { confirmation: `BISECT ${id}`, reason: "go ahead, 10% canary" })).json.incident.state, "PROBING");
    await ticksUntil(() => stateOf(id) === "IDENTIFIED", 3000);
    const done = (await call("GET", `/api/incidents/${id}`)).json.incident;
    assert.deepEqual(done.conclusion.ids.sort(), ["sim:fast_checkout", "sim:new_tax_engine"]);
    assert.equal(done.confirmed, true);
    assert.ok(done.rounds <= 10, `rounds ${done.rounds}`);
    assert.ok(done.probes.at(-1).verdict === "healed");
    // Remediation needs two different people and a typed confirmation.
    assert.equal((await call("POST", `/api/incidents/${id}/remediation`, { action: "approve", confirmation: `REMEDIATE ${id}`, reason: "ship it" })).status, 409);
    assert.equal((await call("POST", `/api/incidents/${id}/remediation`, { action: "propose", reason: "Restore both flags; confirmed by canary" })).json.incident.state, "REMEDIATION_PROPOSED");
    const self = await call("POST", `/api/incidents/${id}/remediation`, { action: "approve", confirmation: `REMEDIATE ${id}`, reason: "approve myself" });
    assert.equal(self.status, 403); assert.equal(self.json.error.code, "self_approval_forbidden");
    assert.equal((await call("POST", `/api/incidents/${id}/remediation`, { action: "approve", confirmation: "REMEDIATE", reason: "ok" }, as("bob"))).status, 400);
    const ok = await call("POST", `/api/incidents/${id}/remediation`, { action: "approve", confirmation: `REMEDIATE ${id}`, reason: "Evidence reviewed" }, as("bob"));
    assert.equal(ok.json.incident.state, "REMEDIATED");
    assert.ok(ok.json.incident.remediation.result.restored.every((r: { verified: boolean }) => r.verified));
    await ticksUntil(() => stateOf(id) === "RESOLVED", 400);
    const kinds = (await call("GET", `/api/ledger?subjectType=incident&subjectId=${id}&limit=200`)).json.entries.map((e: { kind: string }) => e.kind);
    for (const k of ["incident.opened", "bisect.envelope.approved", "bisect.probe", "bisect.concluded", "remediation.proposed", "remediation.approved", "remediation.executed", "incident.resolved"]) assert.ok(kinds.includes(k), `missing ${k}`);
    assert.equal((await call("GET", "/api/ledger/verify")).json.ok, true);
    const agents = new Set(done.messages.map((m: { agent: string }) => m.agent));
    for (const a of ["sentinel", "archivist", "profiler", "guardian", "prober", "judge", "scribe"]) assert.ok(agents.has(a), `agent ${a} never spoke`);
  });

  it("not_flags__external_outage__concludes_not_a_flag_change_and_removes_the_canary", async () => {
    await start();
    await call("POST", "/api/incidents/simulate", { scenario: "not-flags" });
    await ticksUntil(() => latestId() > 0 && stateOf(latestId()) === "AWAITING_APPROVAL", 200);
    const id = latestId();
    await call("POST", `/api/incidents/${id}/envelope`, { confirmation: `BISECT ${id}`, reason: "investigate" });
    await ticksUntil(() => ["NOT_A_FLAG_CHANGE", "INCONCLUSIVE"].includes(stateOf(id)), 4000);
    const v = (await call("GET", `/api/incidents/${id}`)).json.incident;
    assert.equal(v.state, "NOT_A_FLAG_CHANGE", JSON.stringify(v.probes.map((p: { verdict: string }) => p.verdict)));
    assert.equal(v.canary, null);
  });

  it("abort__by_a_person__stops_probing_and_tears_down", async () => {
    await start();
    await call("POST", "/api/incidents/simulate", { scenario: "single" });
    await ticksUntil(() => latestId() > 0 && stateOf(latestId()) === "AWAITING_APPROVAL", 200);
    const id = latestId();
    await call("POST", `/api/incidents/${id}/envelope`, { confirmation: `BISECT ${id}`, reason: "investigate" });
    await runtime().tick();
    assert.equal((await call("POST", `/api/incidents/${id}/abort`, { reason: "x" })).status, 400);
    const r = await call("POST", `/api/incidents/${id}/abort`, { reason: "Paging the owning team instead" });
    assert.equal(r.json.incident.state, "ABORTED");
    assert.equal(r.json.incident.canary, null);
  });

  it("envelope__out_of_range_overrides__are_refused", async () => {
    await start();
    await call("POST", "/api/incidents/simulate", { scenario: "single" });
    await ticksUntil(() => latestId() > 0 && stateOf(latestId()) === "AWAITING_APPROVAL", 200);
    const id = latestId();
    assert.equal((await call("POST", `/api/incidents/${id}/envelope`, { confirmation: `BISECT ${id}`, reason: "wide canary", canaryPercent: 50 })).status, 400);
    assert.equal((await call("POST", `/api/incidents/${id}/envelope`, { confirmation: `BISECT ${id}`, reason: "smaller canary", canaryPercent: 3 })).json.incident.envelope.canaryPercent, 3);
  });
});

describe("incident swarm: against a Flagsmith double", () => {
  it("real__webhook_audit_segment_overrides_and_remediation__end_to_end", async () => {
    await start(true);
    const f = fake!;
    const rnd = mulberry32(5);
    const T0 = clock;
    // Healthy traffic first, then four flag changes; the new tax engine is the culprit.
    const traffic = async (n: number): Promise<void> => {
      const signals = [];
      for (let i = 0; i < n; i++) {
        const identity = `cust-${Math.floor(rnd() * 5000)}`;
        const flags = f.flagsFor(identity);
        const broken = flags.new_tax_engine!.enabled;
        signals.push({ ts: clock, identity, ok: rnd() >= (broken ? 0.09 : 0.01), flags });
      }
      const r = await call("POST", "/api/bisect/signals", { signals }, { "x-ingest-key": INGEST });
      assert.equal(r.status, 200, JSON.stringify(r.json));
    };
    for (let m = 0; m < 10; m++) { await traffic(400); clock += 60_000; }
    f.changeFlag("promo_banner", { enabled: true, value: "black_friday" }, "marketing@shop", clock - 50_000);
    f.changeFlag("search_reranker", { enabled: true, value: "hybrid_v2" }, "sam@shop", clock - 40_000);
    // fast_checkout arrives through a signed webhook (no audit fallback needed for it).
    f.changeFlag("fast_checkout", { enabled: true, value: null }, "lee@shop", clock - 30_000);
    const hook = { event_type: "FLAG_UPDATED", data: { changed_by: "lee@shop", timestamp: new Date(clock - 30_000).toISOString(), new_state: { feature: { id: f.flags.get("fast_checkout")!.id, name: "fast_checkout" }, identity: null, identity_identifier: null, feature_segment: null, enabled: true, feature_state_value: null }, previous_state: { feature: { id: f.flags.get("fast_checkout")!.id, name: "fast_checkout" }, identity: null, feature_segment: null, enabled: false, feature_state_value: null } } };
    const raw = JSON.stringify(hook);
    const bad = await fetch(`${base}/api/flagsmith/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-flagsmith-signature": "0".repeat(64) }, body: raw });
    assert.equal(bad.status, 401);
    const good = await fetch(`${base}/api/flagsmith/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-flagsmith-signature": createHmac("sha256", HOOK).update(raw).digest("hex") }, body: raw });
    assert.deepEqual(await good.json(), { recorded: true, feature: "fast_checkout" });
    f.changeFlag("new_tax_engine", { enabled: true, value: null }, "fin-platform", clock - 20_000);
    await ticksUntil(() => latestId() > 0 && stateOf(latestId()) === "AWAITING_APPROVAL", 40, async () => { await traffic(400); clock += 60_000; });
    const id = latestId();
    const v = (await call("GET", `/api/incidents/${id}`)).json.incident;
    assert.deepEqual(v.suspects.map((s: { feature: string }) => s.feature).sort(), ["fast_checkout", "new_tax_engine", "promo_banner", "search_reranker"]);
    assert.deepEqual(v.suspects.find((s: { feature: string }) => s.feature === "search_reranker").before, { enabled: true, value: "bm25" });
    assert.equal(f.segments.size, 0);
    await call("POST", `/api/incidents/${id}/envelope`, { confirmation: `BISECT ${id}`, reason: "Approve a 10% canary", canaryPercent: 10 });
    let sawOverride = false;
    await ticksUntil(() => stateOf(id) === "IDENTIFIED", 600, async () => {
      if ([...f.flags.values()].some((x) => x.overrides.size > 0)) sawOverride = true;
      await traffic(500); clock += 20_000;
    });
    assert.ok(sawOverride, "probes must be real segment overrides");
    assert.equal(f.segments.size, 0, "canary segment removed after the conclusion");
    const done = (await call("GET", `/api/incidents/${id}`)).json.incident;
    assert.equal(done.conclusion.key, `fs:${f.flags.get("new_tax_engine")!.id}`);
    await call("POST", `/api/incidents/${id}/remediation`, { action: "propose", reason: "Turn the new tax engine back off" });
    const r = await call("POST", `/api/incidents/${id}/remediation`, { action: "approve", confirmation: `REMEDIATE ${id}`, reason: "Agreed" }, as("bob"));
    assert.equal(r.json.incident.state, "REMEDIATED");
    assert.equal(f.flags.get("new_tax_engine")!.enabled, false);
    assert.equal(f.flags.get("fast_checkout")!.enabled, true, "innocent changes stay");
    await ticksUntil(() => stateOf(id) === "RESOLVED", 30, async () => { await traffic(500); clock += 60_000; });
    assert.ok(clock - T0 < 6 * 3_600_000);
  });

  it("signals__invalid_payloads__are_rejected", async () => {
    await start();
    const post = (signals: unknown) => call("POST", "/api/bisect/signals", { signals }, { "x-ingest-key": INGEST });
    assert.equal((await post([])).status, 400);
    assert.equal((await post([{ identity: "a b", ok: true, flags: { x: { enabled: true } } }])).status, 400);
    assert.equal((await post([{ identity: "a", ok: "yes", flags: { x: { enabled: true } } }])).status, 400);
    assert.equal((await post([{ identity: "a", ok: true, flags: {} }])).status, 400);
    assert.equal((await post([{ identity: "a", ok: true, ts: clock + 3_600_000, flags: { x: { enabled: true } } }])).status, 400);
    assert.equal((await call("POST", "/api/bisect/signals", { signals: [{ identity: "a", ok: true, flags: { x: { enabled: true } } }] }, as("alice"))).status, 401);
    assert.equal((await post([{ identity: "a", ok: true, flags: { x: { enabled: true, value: "v" } } }])).json.stored, 1);
  });
});
