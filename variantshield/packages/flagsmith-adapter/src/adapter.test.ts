import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { FlagsmithClient, FlagsmithError, normaliseBaseUrl } from "./index.ts";
import { sampleResultsPayload, SAMPLE_EXPERIMENT, startFakeFlagsmith, type FakeFlagsmith } from "./testing/fake-flagsmith.ts";

let fake: FakeFlagsmith;
const client = (over: Record<string, unknown> = {}): FlagsmithClient =>
  new FlagsmithClient({
    baseUrl: fake.url, environmentKey: fake.environmentKey, admin: { scheme: "Api-Key", value: fake.adminKey },
    retry: { retries: 2, baseDelayMs: 1, maxDelayMs: 2 }, sleep: async () => {}, ...over,
  });
const code = async (p: Promise<unknown>): Promise<FlagsmithError> => {
  try { await p; } catch (e) { assert.ok(e instanceof FlagsmithError, String(e)); return e; }
  throw new Error("expected rejection");
};

beforeEach(async () => { fake = await startFakeFlagsmith({ experiments: [SAMPLE_EXPERIMENT], pageSize: 1 }); });
afterEach(async () => { await fake.close(); });

describe("flagsmith adapter (against a contract double)", () => {
  it("normaliseBaseUrl__tolerates_api_suffix_and_rejects_garbage", () => {
    assert.equal(normaliseBaseUrl("http://localhost:8000/api/v1/"), "http://localhost:8000");
    assert.equal(normaliseBaseUrl("https://flags.example.com/"), "https://flags.example.com");
    assert.throws(() => normaliseBaseUrl("ftp://x"), FlagsmithError);
    assert.throws(() => normaliseBaseUrl("not a url"), FlagsmithError);
  });

  it("listExperiments__paginated__follows_next_links", async () => {
    fake.experiments.set(8, { ...SAMPLE_EXPERIMENT, id: 8, name: "Second", featureName: "other" });
    const list = await client().listExperiments();
    assert.deepEqual(list.map((e) => e.id).sort(), [7, 8]);
    assert.ok(fake.calls.filter((c) => c.path.endsWith("/experiments/")).length >= 2);
  });

  it("getExperiment__returns_flagsmith_status_not_a_guess", async () => {
    const e = await client().getExperiment(7);
    assert.equal(e.status, "running");
    assert.equal(e.featureName, "checkout_flow");
  });

  it("transition__pause_then_resume__follows_documented_lifecycle", async () => {
    assert.equal((await client().transition(7, "pause")).status, "paused");
    assert.equal((await client().transition(7, "start")).status, "running");
  });

  it("transition__invalid_state_change__is_validation_error_and_not_retried", async () => {
    await client().transition(7, "complete");
    const err = await code(client().transition(7, "pause"));
    assert.equal(err.kind, "validation");
    assert.equal(fake.calls.filter((c) => c.path.endsWith("/pause/")).length, 1);
  });

  it("request__wrong_admin_key__is_forbidden_without_leaking_credentials", async () => {
    const err = await code(client({ admin: { scheme: "Api-Key", value: "nope" } }).getExperiment(7));
    assert.equal(err.kind, "forbidden");
    assert.doesNotMatch(JSON.stringify(err), /nope/);
  });

  it("request__no_admin_credential__is_config_error_before_any_call", async () => {
    const before = fake.calls.length;
    const err = await code(client({ admin: undefined }).getExperiment(7));
    assert.equal(err.kind, "config");
    assert.equal(fake.calls.length, before);
  });

  it("request__transient_503_on_read__is_retried_until_success", async () => {
    fake.failNext("/experiments/7/", 503, 2);
    assert.equal((await client().getExperiment(7)).id, 7);
  });

  it("request__persistent_503_on_read__surfaces_unavailable_after_retries", async () => {
    fake.failNext("/experiments/7/", 503, 10);
    const err = await code(client().getExperiment(7));
    assert.equal(err.kind, "unavailable");
    assert.equal(fake.calls.filter((c) => c.path === `/api/v1/environments/${fake.environmentKey}/experiments/7/`).length, 3);
  });

  it("request__429_with_retry_after__waits_at_least_that_long", async () => {
    const waits: number[] = [];
    fake.failNext("/experiments/7/", 429, 1, { "retry-after": "2" });
    await client({ sleep: async (ms: number) => void waits.push(ms) }).getExperiment(7);
    assert.ok(waits[0]! >= 2000);
  });

  it("request__mutation_hitting_503__is_never_retried", async () => {
    fake.failNext("/pause/", 503, 5);
    const err = await code(client().transition(7, "pause"));
    assert.equal(err.kind, "unavailable");
    assert.equal(fake.calls.filter((c) => c.path.endsWith("/pause/")).length, 1);
  });

  it("request__server_down__is_network_error", async () => {
    const c = client();
    await fake.close();
    const err = await code(c.getExperiment(7));
    assert.equal(err.kind, "network");
    fake = await startFakeFlagsmith();
  });

  it("getResults__nothing_computed__is_null_not_a_winner", async () => {
    assert.equal(await client().getResults(7), null);
  });

  it("getResults__real_payload_shape__derives_winner_from_flagsmith_inference", async () => {
    fake.results.set(7, sampleResultsPayload());
    const r = await client().getResults(7);
    assert.equal(r?.summary.winner, "upi_first");
    assert.equal(r?.summary.significant, true);
    assert.equal(r?.summary.lift, "+20.0%");
    assert.equal(r?.summary.chanceToWin.upi_first, 0.99);
    assert.equal(r?.summary.variants.find((v) => v.variant === "control")?.conversionRate, 0.3);
  });

  it("getResults__below_flagsmith_sample_floors__never_declares_winner", async () => {
    fake.results.set(7, sampleResultsPayload({ n: 20 }));
    const r = await client().getResults(7);
    assert.equal(r?.summary.winner, null);
    assert.match(r?.summary.sampleSizeWarning ?? "", /floors of 50 identities/);
  });

  it("getResults__credible_interval_spans_zero__is_not_a_winner", async () => {
    fake.results.set(7, sampleResultsPayload({ winner: null }));
    assert.equal((await client().getResults(7))?.summary.winner, null);
  });

  it("getExposures__sums_new_identities_per_variant", async () => {
    fake.exposures.set(7, { excluded_identities: 2, timeseries: { granularity: "hour", points: [{ bucket: "a", new_identities: { control: 10, upi_first: 12 } }, { bucket: "b", new_identities: { control: 5 } }] } });
    const e = await client().getExposures(7);
    assert.deepEqual(e?.variants, [{ variant: "control", identities: 15 }, { variant: "upi_first", identities: 12 }]);
    assert.equal(e?.excludedIdentities, 2);
  });

  it("getIdentityAssignment__running_experiment__returns_served_variant_deterministically", async () => {
    const a = await client().getIdentityAssignment("user-1", "checkout_flow");
    const b = await client().getIdentityAssignment("user-1", "checkout_flow");
    assert.ok(["control", "upi_first", "one_tap"].includes(a.variantKey!));
    assert.deepEqual(a, b);
  });

  it("getIdentityAssignment__unknown_flag__reports_reason_instead_of_defaulting", async () => {
    const a = await client().getIdentityAssignment("user-1", "does_not_exist");
    assert.deepEqual([a.variantKey, a.reason], [null, "flag_not_found"]);
  });

  it("getIdentityAssignment__bad_environment_key__is_auth_error", async () => {
    const err = await code(client({ environmentKey: "wrong" }).getIdentityAssignment("u", "checkout_flow"));
    assert.equal(err.kind, "auth");
  });

  it("sendExposure__posts_flag_exposure_event_with_variant_as_value", async () => {
    await client().sendExposure("user-1", "checkout_flow", "upi_first", 1_800_000_000_000);
    assert.deepEqual(fake.events[0], { event: "$flag_exposure", feature_name: "checkout_flow", identifier: "user-1", timestamp: 1_800_000_000_000, value: "upi_first" });
  });

  it("parseExperiment__unknown_status__is_contract_error", async () => {
    fake.experiments.get(7)!.status = "DRAFT" as never;
    assert.equal((await code(client().getExperiment(7))).kind, "contract");
  });

  it("describe__never_exposes_admin_credential", () => {
    assert.doesNotMatch(JSON.stringify(client().describe()), /test-admin-key/);
  });

  it("getAssignmentConfig__reads_default_and_experiment_override_with_weights", async () => {
    const c = await client().getAssignmentConfig("checkout_flow");
    assert.equal(c.environmentName, "Production");
    assert.equal(c.states.length, 2);
    const experiment = c.states.find((s) => s.segmentId !== null)!;
    assert.deepEqual(experiment.weights, [{ value: "one_tap", percentage: 33.3 }, { value: "upi_first", percentage: 33.3 }]);
    assert.match(c.fingerprint, /^[a-f0-9]{16}$/);
  });

  it("getAssignmentConfig__weights_changed__changes_the_fingerprint", async () => {
    const before = (await client().getAssignmentConfig("checkout_flow")).fingerprint;
    assert.equal((await client().getAssignmentConfig("checkout_flow")).fingerprint, before, "stable while nothing changes");
    fake.setWeight(7, "upi_first", 50);
    assert.notEqual((await client().getAssignmentConfig("checkout_flow")).fingerprint, before);
  });

  it("getAssignmentConfig__unknown_feature__is_not_found", async () => {
    assert.equal((await code(client().getAssignmentConfig("nope"))).kind, "not_found");
  });

  it("getAssignmentConfig__without_admin_credential__is_config_error", async () => {
    assert.equal((await code(client({ admin: undefined }).getAssignmentConfig("checkout_flow"))).kind, "config");
  });
});
