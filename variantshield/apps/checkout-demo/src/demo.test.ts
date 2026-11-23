import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { FlagsmithClient } from "../../../packages/flagsmith-adapter/src/index.ts";
import { SAMPLE_EXPERIMENT, startFakeFlagsmith, type FakeFlagsmith } from "../../../packages/flagsmith-adapter/src/testing/fake-flagsmith.ts";
import { createDemoApp, type DemoApp } from "./server.ts";
import type { EmitInput, Telemetry } from "./instrument.ts";

let fake: FakeFlagsmith;
let demo: DemoApp;
let base: string;
let emitted: EmitInput[];
const KEY = "demo-control-key-1234";
const telemetry: Telemetry = { emit: (e) => void emitted.push(e), flush: async () => {} };

async function boot(over: Partial<Parameters<typeof createDemoApp>[0]["cfg"]> = {}, flagsmith: FlagsmithClient | null | undefined = undefined): Promise<void> {
  const client = flagsmith === undefined ? new FlagsmithClient({ baseUrl: fake.url, environmentKey: fake.environmentKey, retry: { retries: 0, baseDelayMs: 1, maxDelayMs: 1 }, timeoutMs: 1000 }) : flagsmith;
  demo = createDemoApp({ flagsmith: client, telemetry, cfg: { featureKey: "checkout_flow", latencyScale: 0.001, allowOverride: false, allowUidHeader: true, controlKey: KEY, ...over } });
  await new Promise<void>((r) => demo.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(demo.server.address() as AddressInfo).port}`;
}
const as = (uid: string, init: RequestInit = {}) => ({ ...init, headers: { "x-demo-uid": uid, "content-type": "application/json", ...(init.headers ?? {}) } });
const pay = (uid: string, key: string) => fetch(`${base}/api/pay`, as(uid, { method: "POST", body: JSON.stringify({ idempotencyKey: key }) }));
const waitFor = async (pred: () => boolean): Promise<void> => { for (let i = 0; i < 50 && !pred(); i++) await new Promise((r) => setTimeout(r, 10)); };

beforeEach(async () => { emitted = []; fake = await startFakeFlagsmith({ experiments: [SAMPLE_EXPERIMENT] }); });
afterEach(async () => { await new Promise<void>((r) => demo.server.close(() => r())); await fake.close(); });

describe("checkout demo", () => {
  it("page__variant_comes_from_flagsmith_and_exposure_is_recorded", async () => {
    await boot();
    const served = (await (await fetch(`${base}/`, as("user-abc"))).text()).match(/data-variant="(\w+)"/)![1];
    const expected = (await new FlagsmithClient({ baseUrl: fake.url, environmentKey: fake.environmentKey }).getIdentityAssignment("user-abc", "checkout_flow")).variantKey;
    assert.equal(served, expected);
    await waitFor(() => fake.events.length > 0);
    assert.equal(fake.events[0]!.event, "$flag_exposure");
    assert.equal(fake.events[0]!.value, expected);
  });

  it("page__url_variant_override__is_ignored_unless_explicitly_enabled", async () => {
    await boot();
    const html = await (await fetch(`${base}/?variant=one_tap`, as("user-ignore"))).text();
    const flagged = (await new FlagsmithClient({ baseUrl: fake.url, environmentKey: fake.environmentKey }).getIdentityAssignment("user-ignore", "checkout_flow")).variantKey;
    assert.equal(html.match(/data-variant="(\w+)"/)![1], flagged);
  });

  it("page__flagsmith_down__shows_banner_and_telemetry_has_no_variant", async () => {
    await boot();
    await fake.close();
    const html = await (await fetch(`${base}/`, as("user-down"))).text();
    assert.match(html, /Could not reach Flagsmith/);
    await pay("user-down", "k1");
    assert.ok(emitted.length > 0 && emitted.every((e) => e.assignment.source === "unassigned" && e.assignment.variantKey === null));
    fake = await startFakeFlagsmith();
  });

  it("pay__success__emits_attributed_events_and_flagsmith_conversion", async () => {
    await boot();
    await fetch(`${base}/`, as("user-ok"));
    const res = await pay("user-ok", "k1");
    assert.equal((await res.json() as { status: string }).status, "ok");
    const types = emitted.map((e) => e.type);
    for (const t of ["checkout_started", "http_request", "checkout_completed", "checkout_latency"]) assert.ok(types.includes(t as never), t);
    assert.ok(emitted.every((e) => e.assignment.source === "flagsmith" && e.assignment.variantKey));
    assert.ok(emitted.find((e) => e.type === "checkout_latency")!.latencyMs! >= 0);
    await waitFor(() => fake.events.some((e) => e.event === "checkout_completed"));
    assert.ok(fake.events.some((e) => e.event === "checkout_completed" && e.identifier === "user-ok"));
  });

  it("override__enabled__records_no_variant_in_telemetry", async () => {
    await boot({ allowOverride: true }, null);
    const r = await fetch(`${base}/?variant=upi_first`, as("user-ov"));
    assert.match(await r.text(), /data-variant="upi_first"/);
    const cookie = r.headers.getSetCookie().find((c) => c.startsWith("vs_override="))!.split(";")[0]!;
    await fetch(`${base}/api/pay`, as("user-ov", { method: "POST", body: "{}", headers: { cookie } }));
    assert.ok(emitted.length > 0 && emitted.every((e) => e.assignment.source === "override"));
  });

  it("fault__requires_control_key", async () => {
    await boot();
    assert.equal((await fetch(`${base}/__fault`, { method: "POST", body: JSON.stringify({ variant: "upi_first", type: "payment_failures" }) })).status, 401);
    assert.equal((await fetch(`${base}/__fault`, { method: "POST", headers: { "x-demo-key": KEY }, body: JSON.stringify({ variant: "upi_first", type: "bogus" }) })).status, 400);
  });

  it("fault__payment_failures__only_affect_the_targeted_variant", async () => {
    await boot();
    const probe = new FlagsmithClient({ baseUrl: fake.url, environmentKey: fake.environmentKey });
    const byVariant: Record<string, string> = {};
    for (let i = 0; i < 40 && Object.keys(byVariant).length < 2; i++) { const v = (await probe.getIdentityAssignment(`user-${i}`, "checkout_flow")).variantKey!; if (v === "control" || v === "upi_first") byVariant[v] ??= `user-${i}`; }
    await fetch(`${base}/__fault`, { method: "POST", headers: { "x-demo-key": KEY }, body: JSON.stringify({ variant: "upi_first", type: "payment_failures", rate: 1 }) });
    assert.equal((await (await pay(byVariant.upi_first!, "a")).json() as { status: string }).status, "declined");
    assert.equal((await (await pay(byVariant.control!, "b")).json() as { status: string }).status, "ok");
    assert.ok(emitted.some((e) => e.type === "payment_failed" && e.assignment.variantKey === "upi_first"));
    assert.ok(!emitted.some((e) => e.type === "payment_failed" && e.assignment.variantKey === "control"));
  });

  it("duplicate__same_key_replays_first_result__without_second_charge", async () => {
    await boot();
    await fetch(`${base}/`, as("user-dup"));
    const first = await (await pay("user-dup", "same")).json() as { orderId: string };
    const second = await (await pay("user-dup", "same")).json() as { orderId: string; replay: boolean };
    assert.equal(second.orderId, first.orderId);
    assert.equal(second.replay, true);
    assert.equal(emitted.filter((e) => e.type === "checkout_completed").length, 1);
    assert.ok(emitted.some((e) => e.type === "duplicate_submit" && e.outcome === "rejected"));
  });

  it("duplicate__fresh_key_inside_window__is_a_double_charge_attempt", async () => {
    await boot();
    await fetch(`${base}/`, as("user-dbl"));
    await pay("user-dbl", "one");
    await pay("user-dbl", "two");
    assert.ok(emitted.some((e) => e.type === "duplicate_submit" && e.outcome === "failure"));
    assert.equal(emitted.filter((e) => e.type === "checkout_completed").length, 2);
  });

  it("page__duplicate_fault_active__removes_the_client_guard_for_that_variant_only", async () => {
    await boot();
    const probe = new FlagsmithClient({ baseUrl: fake.url, environmentKey: fake.environmentKey });
    const target = (await probe.getIdentityAssignment("user-guard", "checkout_flow")).variantKey!;
    await fetch(`${base}/__fault`, { method: "POST", headers: { "x-demo-key": KEY }, body: JSON.stringify({ variant: target, type: "duplicate_submissions" }) });
    assert.match(await (await fetch(`${base}/`, as("user-guard"))).text(), /data-no-guard="true"/);
    await fetch(`${base}/__fault`, { method: "DELETE", headers: { "x-demo-key": KEY } });
    assert.doesNotMatch(await (await fetch(`${base}/`, as("user-guard"))).text(), /data-no-guard/);
  });
});
