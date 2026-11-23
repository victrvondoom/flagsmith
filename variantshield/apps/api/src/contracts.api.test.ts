import { postAsSurfaces } from "./testing/observations.ts";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { createApp, type App } from "./app.ts";
import { buildFlagsmith } from "./context.ts";
import { EXAMPLE_MANIFEST } from "./contract-sim.ts";
import { startFakeFlagsmith, type FakeExperiment, type FakeFlagsmith } from "../../../packages/flagsmith-adapter/src/testing/fake-flagsmith.ts";

process.env.VARIANTSHIELD_LOG = "off";
const ADMIN = "admin-token-for-tests-0123", INGEST = "ingest-key-for-tests-0123", ISSUER = "issuer-key-for-tests-0123", SECRET = "identity-secret-for-tests-0123456789";
const FLAG: FakeExperiment = { id: 9, name: "Checkout journey", hypothesis: "", status: "running", featureName: "checkout_journey_variant", variants: ["control", "upi_first"], weights: { control: 0.5, upi_first: 0.5 } };
let fake: FakeFlagsmith, app: App, base: string;
let clock = 1_800_000_000_000;

const manifest = (over: (m: any) => void = () => {}): any => { const m = parseYaml(readFileSync(EXAMPLE_MANIFEST, "utf8")); over(m); return m; };
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${ADMIN}` }) {
  // Observations are reported per surface with that surface's own key (the master ingest key is not accepted there).
  if (path === "/api/contract-observations" && method === "POST" && headers["x-ingest-key"] === INGEST) return postAsSurfaces(base, INGEST, body);
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const asIngest = { "x-ingest-key": INGEST };
const asIssuer = { "x-identity-issuer-key": ISSUER };
const FEATS: Record<string, Record<string, string>> = { control: { checkout_ui: "classic", payment_route: "legacy", retry_policy: "standard" }, upi_first: { checkout_ui: "upi_first", payment_route: "upi_intent_v2", retry_policy: "bounded" } };
const SURF: Record<string, string[]> = { "web-checkout": ["checkout_ui"], "mobile-checkout": ["checkout_ui"], "payment-api": ["payment_route"], "risk-engine": ["retry_policy"] };

const identity = async (subject: string) => (await call("POST", "/api/identity/issue", { subject }, asIssuer)).json as { subjectRef: string; token: string };
const surfaceObs = (id: { token: string }, tag: string, variant: string, over: Record<string, Record<string, unknown>> = {}, contractId = "checkout-journey", at = clock - 20_000) =>
  Object.entries(SURF).map(([surfaceId, feats]) => ({
    observationId: `${tag}-${surfaceId}`, contractId, contractVersion: 1, experimentKey: "checkout_journey", environment: "production", envFingerprint: "aaaaaaaaaaaaaaaa",
    assignmentFlag: "checkout_journey_variant", assignedVariant: variant, surfaceId, identityToken: id.token, observedAt: at, features: Object.fromEntries(feats.map((f) => [f, FEATS[variant]![f]])), ...(over[surfaceId] ?? {}),
  }));
const flagsmithAssignment = async (subjectRef: string): Promise<string> => ((await (await fetch(`${fake.url}/api/v1/identities/?identifier=${subjectRef}`, { headers: { "x-environment-key": fake.environmentKey } })).json()) as any).flags[0].feature_state_value;
const report = async (id = "checkout-journey", q = "") => (await call("GET", `/api/contracts/${id}/report${q}`)).json;

beforeEach(async () => {
  fake = await startFakeFlagsmith({ experiments: [FLAG] });
  const cfg = loadConfig({ VARIANTSHIELD_ADMIN_TOKEN: ADMIN, VARIANTSHIELD_INGEST_KEY: INGEST, VARIANTSHIELD_IDENTITY_ISSUER_KEY: ISSUER, VARIANTSHIELD_IDENTITY_SECRET: SECRET, VARIANTSHIELD_DB_PATH: ":memory:", PORT: "0",
    FLAGSMITH_URL: fake.url, FLAGSMITH_ENVIRONMENT_KEY: fake.environmentKey, FLAGSMITH_ADMIN_API_KEY: fake.adminKey });
  clock = 1_800_000_000_000;
  app = createApp({ cfg, db: new Db(":memory:"), now: () => clock, flagsmith: buildFlagsmith(cfg) });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>((r) => app.server.close(() => r())); app.ctx.db.close(); await fake.close(); });

describe("contracts API: manifests", () => {
  it("validate__example__is_valid_and_invalid_manifest_lists_issues_with_paths", async () => {
    const ok = await call("POST", "/api/contracts/validate", manifest());
    assert.equal(ok.json.valid, true);
    const bad = await call("POST", "/api/contracts/validate", manifest((m) => { delete m.experiment; m.surfaces.push({ id: "web-checkout" }); }));
    assert.equal(bad.json.valid, false);
    assert.ok(bad.json.issues.some((i: any) => i.path === "experiment") && bad.json.issues.some((i: any) => /duplicate surface/.test(i.message)));
  });

  it("validate__yaml_text__is_accepted", async () => {
    const r = await call("POST", "/api/contracts/validate", { yaml: readFileSync(EXAMPLE_MANIFEST, "utf8") });
    assert.equal(r.json.valid, true);
  });

  it("register__invalid_manifest__is_400_and_nothing_is_stored", async () => {
    const r = await call("POST", "/api/contracts", manifest((m) => { m.variants.upi_first.payment_route = "legacy"; }));
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, "contract_invalid");
    assert.equal((await call("GET", "/api/contracts")).json.contracts.length, 0);
  });

  it("register__same_version_same_content__is_idempotent_and_changed_content_is_immutable_conflict", async () => {
    assert.equal((await call("POST", "/api/contracts", manifest())).json.status, "created");
    assert.equal((await call("POST", "/api/contracts", manifest())).json.status, "unchanged");
    const changed = await call("POST", "/api/contracts", manifest((m) => { m.freshness.max_age_seconds = 60; }));
    assert.equal(changed.status, 409);
    assert.equal(changed.json.error.code, "contract_version_immutable");
  });

  it("register__lower_version__is_rejected", async () => {
    await call("POST", "/api/contracts", manifest((m) => { m.contract.version = 3; }));
    assert.equal((await call("POST", "/api/contracts", manifest((m) => { m.contract.version = 2; }))).json.error.code, "version_not_increasing");
  });

  it("register__requires_admin_token", async () => {
    assert.equal((await call("POST", "/api/contracts", manifest(), {})).status, 401);
  });
});

describe("contracts API: identity", () => {
  it("issue__requires_issuer_key_and_rejects_emails", async () => {
    assert.equal((await call("POST", "/api/identity/issue", { subject: "cust-1" }, { "x-identity-issuer-key": "wrong" })).status, 401);
    assert.equal((await call("POST", "/api/identity/issue", { subject: "cust-1" }, { authorization: `Bearer ${ADMIN}` })).status, 401, "admin token must not issue identities");
    const email = await call("POST", "/api/identity/issue", { subject: "jane@example.com" }, asIssuer);
    assert.equal(email.status, 400);
    assert.equal(email.json.error.code, "invalid_subject");
  });

  it("issue__same_customer_gets_the_same_subject_ref_on_every_call_and_service", async () => {
    const a = await identity("cust-42"), b = await identity("cust-42"), other = await identity("cust-43");
    assert.equal(a.subjectRef, b.subjectRef);
    assert.notEqual(a.subjectRef, other.subjectRef);
    assert.doesNotMatch(JSON.stringify(a), /cust-42/);
  });

  it("verify__valid_tampered_and_expired_tokens", async () => {
    const a = await identity("cust-42");
    const ok = await call("POST", "/api/identity/verify", { token: a.token }, asIngest);
    assert.deepEqual([ok.json.valid, ok.json.subjectRef], [true, a.subjectRef]);
    assert.equal((await call("POST", "/api/identity/verify", { token: a.token.slice(0, -3) + "xyz" }, asIngest)).json.reason, "bad_signature");
    clock += 2 * 3600_000;
    assert.equal((await call("POST", "/api/identity/verify", { token: a.token }, asIngest)).json.reason, "expired");
  });

  it("issue__anonymous_shared_id__yields_an_anon_subject", async () => {
    const r = await call("POST", "/api/identity/issue", { anonymousId: "edge-visitor-123" }, asIssuer);
    assert.match(r.json.subjectRef, /^anon_/);
  });
});

describe("contracts API: observations and evaluation", () => {
  beforeEach(async () => { await call("POST", "/api/contracts", manifest()); });

  it("ingest__correct_four_surfaces__report_is_contract_valid_with_one_subject_row", async () => {
    const id = await identity("cust-1");
    const r = await call("POST", "/api/contract-observations", { observations: surfaceObs(id, "s1", "upi_first") }, asIngest);
    assert.deepEqual([r.json.accepted, r.json.rejected, r.json.unlinked], [4, 0, 0]);
    const rep = (await report()).report;
    assert.equal(rep.status, "CONTRACT_VALID");
    assert.equal(rep.subjects.length, 1);
    assert.equal(rep.subjects[0].subjectRef, id.subjectRef);
    assert.ok(rep.surfaces.every((s: any) => s.status === "compliant"));
  });

  it("ingest__wrong_payment_route_and_risk_policy__is_combination_violation_naming_the_surfaces", async () => {
    const id = await identity("cust-2");
    await call("POST", "/api/contract-observations", { observations: surfaceObs(id, "s2", "upi_first", { "payment-api": { features: { payment_route: "legacy" } }, "risk-engine": { features: { retry_policy: "standard" } } }) }, asIngest);
    const rep = (await report()).report;
    assert.equal(rep.primaryCode, "COMBINATION_VIOLATION");
    const bySurface = Object.fromEntries(rep.surfaces.map((s: any) => [s.id, s.status]));
    assert.equal(bySurface["web-checkout"], "compliant");
    assert.equal(bySurface["payment-api"], "violating");
    assert.equal(bySurface["risk-engine"], "violating");
  });

  it("ingest__duplicate_replay__is_idempotent_and_conflicting_payload_is_rejected", async () => {
    const id = await identity("cust-3");
    const obs = surfaceObs(id, "s3", "control");
    await call("POST", "/api/contract-observations", { observations: obs }, asIngest);
    assert.equal((await call("POST", "/api/contract-observations", { observations: obs }, asIngest)).json.duplicate, 4);
    const conflict = await call("POST", "/api/contract-observations", { observations: [{ ...obs[0], assignedVariant: "upi_first", features: { checkout_ui: "upi_first" } }] }, asIngest);
    assert.match(conflict.json.results[0].issues[0], /idempotency conflict/);
    assert.equal(app.ctx.db.get("SELECT COUNT(*) AS n FROM contract_observations")?.n, 4);
  });

  it("ingest__malformed_unregistered_and_mismatched_records__are_rejected_with_reasons", async () => {
    const id = await identity("cust-4");
    const [good] = surfaceObs(id, "s4", "control");
    const bad = [
      "not an object", { ...good, observationId: "x" }, { ...good, observationId: "s4-unknown-surface", surfaceId: "kiosk" }, { ...good, observationId: "s4-wrong-experiment", experimentKey: "other" },
      { ...good, observationId: "s4-wrong-flag", assignmentFlag: "other_flag" }, { ...good, observationId: "s4-future", observedAt: clock + 3_600_000 }, { ...good, observationId: "s4-badfeat", features: { checkout_ui: { nested: true } } },
      { ...good, observationId: "s4-unknown-version", contractVersion: 9 }, { ...good, observationId: "s4-pii", email: "a@b.co" },
    ];
    const r = await call("POST", "/api/contract-observations", { observations: bad }, asIngest);
    assert.equal(r.json.rejected, bad.length);
    const text = JSON.stringify(r.json.results);
    for (const re of [/not registered/, /does not match the contract/, /in the future/, /malformed/, /unknown contract/, /personal data is not accepted/]) assert.match(text, re);
    assert.equal(app.ctx.db.get("SELECT COUNT(*) AS n FROM contract_observations")?.n, 0);
  });

  it("ingest__requires_ingest_key_and_caps_batch_size", async () => {
    assert.equal((await call("POST", "/api/contract-observations", { observations: [] }, { "x-ingest-key": "nope" })).status, 401);
    assert.equal((await call("POST", "/api/contract-observations", { observations: [] }, asIngest)).status, 400);
    assert.equal((await call("POST", "/api/contract-observations", { observations: new Array(201).fill({}) }, asIngest)).status, 400);
  });

  it("ingest__forged_or_missing_identity_token__is_stored_unlinked_and_flagged_not_guessed", async () => {
    const id = await identity("cust-5");
    const obs = surfaceObs(id, "s5", "control", { "web-checkout": { identityToken: "vsid1.eyJzdWIiOiJzdWJfeCJ9.AAAA" }, "mobile-checkout": { identityToken: undefined } });
    const r = await call("POST", "/api/contract-observations", { observations: obs }, asIngest);
    assert.equal(r.json.unlinked, 2);
    const rep = (await report()).report;
    assert.equal(rep.unlinkedObservations, 2);
    assert.equal(rep.subjects.length, 1, "unlinked observations never create or join a subject");
    assert.ok(rep.findings.some((f: any) => f.code === "IDENTITY_UNLINKED" && f.surfaceId === "web-checkout"));
    assert.equal(rep.status, "CONTRACT_VIOLATION");
  });

  it("ingest__different_subject_on_one_surface__does_not_merge_into_another_subjects_row", async () => {
    const a = await identity("cust-6"), b = await identity("cust-7");
    await call("POST", "/api/contract-observations", { observations: [...surfaceObs(a, "s6a", "control").filter((o) => o.surfaceId !== "risk-engine"), ...surfaceObs(b, "s6b", "upi_first").filter((o) => o.surfaceId === "risk-engine")] }, asIngest);
    const rep = (await report()).report;
    assert.equal(rep.subjects.length, 2);
  });

  it("report__silent_required_surface__is_delayed_then_incomplete_never_a_failure", async () => {
    const id = await identity("cust-8");
    await call("POST", "/api/contract-observations", { observations: surfaceObs(id, "s8", "control").filter((o) => o.surfaceId !== "payment-api") }, asIngest);
    let rep = (await report()).report;
    assert.ok(rep.findings.some((f: any) => f.code === "MISSING_SURFACE" && f.severity === "info"));
    assert.equal(rep.status, "CONTRACT_VALID");
    clock += 600_000;
    rep = (await report()).report;
    assert.ok(rep.findings.some((f: any) => f.code === "MISSING_SURFACE" && f.severity === "warning"));
    assert.equal(rep.status, "CONTRACT_INCOMPLETE");
  });

  it("report__observation_older_than_freshness__is_stale_distinct_from_violation", async () => {
    const id = await identity("cust-9");
    await call("POST", "/api/contract-observations", { observations: surfaceObs(id, "s9", "control", {}, "checkout-journey", clock - 20_000) }, asIngest);
    clock += 1_000_000;
    const rep = (await report()).report;
    assert.ok(rep.findings.some((f: any) => f.code === "STALE_OBSERVATION"));
    assert.ok(!rep.findings.some((f: any) => f.severity === "error"));
  });

  it("check__flagsmith_reverification__flags_a_surface_that_disagrees_with_flagsmith", async () => {
    const id = await identity("cust-10");
    const flagsmithSays = (await (await fetch(`${fake.url}/api/v1/identities/?identifier=${id.subjectRef}`, { headers: { "x-environment-key": fake.environmentKey } })).json() as any).flags[0].feature_state_value as string;
    const other = flagsmithSays === "control" ? "upi_first" : "control";
    await call("POST", "/api/contract-observations", { observations: surfaceObs(id, "s10", other) }, asIngest);
    const r = await call("POST", "/api/contracts/checkout-journey/check");
    assert.equal(r.json.flagsmith.verified, true);
    assert.ok(r.json.report.findings.some((f: any) => f.code === "ASSIGNMENT_MISMATCH" && f.evidence.source === "flagsmith_reverify"), JSON.stringify(r.json.report.findings.map((f: any) => f.code)));
    const ok = await identity("cust-11");
    const says = (await (await fetch(`${fake.url}/api/v1/identities/?identifier=${ok.subjectRef}`, { headers: { "x-environment-key": fake.environmentKey } })).json() as any).flags[0].feature_state_value as string;
    await call("POST", "/api/contract-observations", { observations: surfaceObs(ok, "s11", says) }, asIngest);
    const r2 = await call("POST", "/api/contracts/checkout-journey/check");
    assert.ok(!r2.json.report.findings.some((f: any) => f.subjectRef === ok.subjectRef && f.severity === "error"));
  });

  it("check__flagsmith_unreachable__degrades_to_cross_surface_comparison_with_a_note", async () => {
    const id = await identity("cust-12");
    await call("POST", "/api/contract-observations", { observations: surfaceObs(id, "s12", "control") }, asIngest);
    await fake.close();
    const r = await call("POST", "/api/contracts/checkout-journey/check");
    assert.equal(r.status, 200);
    assert.equal(r.json.flagsmith.verified, false);
    assert.match(r.json.flagsmith.note, /unavailable/);
    fake = await startFakeFlagsmith();
  });

  it("check__assignment_weights_change__is_recorded_as_config_drift_with_the_stability_warning", async () => {
    const id = await identity("cust-13");
    await call("POST", "/api/contract-observations", { observations: surfaceObs(id, "s13", "control") }, asIngest);
    const first = await call("POST", "/api/contracts/checkout-journey/check");
    assert.match(first.json.flagsmith.configFingerprint, /^[a-f0-9]{16}$/);
    assert.equal(first.json.persisted.newDrift, 0);
    fake.setWeight(9, "upi_first", 80);
    const second = await call("POST", "/api/contracts/checkout-journey/check");
    const d = second.json.drift.find((x: any) => x.attribute === "assignment.configuration");
    assert.ok(d);
    assert.match(d.message, /assignment stability may have been affected/);
    assert.equal((await call("POST", "/api/contracts/checkout-journey/check")).json.persisted.newDrift, 0, "unchanged config is not re-reported");
  });

  it("check__findings_are_persisted_once_and_kept_as_history", async () => {
    const id = await identity("cust-14");
    // Report the variant Flagsmith really assigns, then break one surface's resolved value.
    const variant = await flagsmithAssignment(id.subjectRef);
    const wrong = variant === "control" ? "upi_intent_v2" : "legacy";
    await call("POST", "/api/contract-observations", { observations: surfaceObs(id, "s14", variant, { "payment-api": { features: { payment_route: wrong } } }) }, asIngest);
    const a = await call("POST", "/api/contracts/checkout-journey/check");
    assert.ok(a.json.persisted.newFindings > 0);
    const b = await call("POST", "/api/contracts/checkout-journey/check");
    assert.equal(b.json.persisted.newFindings, 0);
    assert.ok(b.json.persisted.updated > 0);
    const list = (await call("GET", "/api/contracts/checkout-journey/findings?code=COMBINATION_VIOLATION")).json.findings;
    assert.ok(list.length > 0 && list[0].evidenceRef.startsWith("finding:") && list[0].expected && list[0].actual && list[0].contractVersion === 1);
  });

  it("drift__surface_that_reported_earlier_and_is_silent_now__is_recorded_without_calling_it_failed", async () => {
    const id = await identity("cust-15");
    await call("POST", "/api/contract-observations", { observations: surfaceObs(id, "s15a", "control") }, asIngest);
    clock += 3600_000 + 60_000;
    const later = await identity("cust-16");
    await call("POST", "/api/contract-observations", { observations: surfaceObs(later, "s15b", "control").filter((o) => o.surfaceId === "web-checkout").map((o) => ({ ...o, observedAt: clock - 10_000 })) }, asIngest);
    const r = await call("POST", "/api/contracts/checkout-journey/check");
    const silent = r.json.drift.filter((d: any) => d.attribute.endsWith(".reporting")).map((d: any) => d.attribute).sort();
    assert.deepEqual(silent, ["surface.mobile-checkout.reporting", "surface.payment-api.reporting", "surface.risk-engine.reporting"]);
  });

  it("drift__same_surface_changes_variant_feature_and_environment_for_one_subject__is_recorded_at_ingest", async () => {
    const id = await identity("cust-17");
    await call("POST", "/api/contract-observations", { observations: surfaceObs(id, "s17a", "control", {}, "checkout-journey", clock - 120_000) }, asIngest);
    const next = surfaceObs(id, "s17b", "upi_first", { "web-checkout": { environment: "staging" } }, "checkout-journey", clock - 10_000).filter((o) => o.surfaceId === "web-checkout");
    await call("POST", "/api/contract-observations", { observations: next }, asIngest);
    const attrs = (await call("GET", "/api/contracts/checkout-journey/drift")).json.drift.map((d: any) => d.attribute).sort();
    assert.deepEqual(attrs, ["assignment.variant", "environment", "feature.checkout_ui"]);
  });
});

describe("contracts API: versions and history", () => {
  it("new_version__keeps_old_version_observations_findings_and_records_drift_without_rewriting_history", async () => {
    await call("POST", "/api/contracts", manifest());
    const id = await identity("cust-20");
    await call("POST", "/api/contract-observations", { observations: surfaceObs(id, "v1", "upi_first", { "payment-api": { features: { payment_route: "legacy" } } }) }, asIngest);
    const v1check = await call("POST", "/api/contracts/checkout-journey/check?version=1");
    assert.equal(v1check.json.report.status, "CONTRACT_VIOLATION");

    const v2 = await call("POST", "/api/contracts", manifest((m) => { m.contract.version = 2; m.variants.upi_first.payment_route = "upi_intent_v3"; m.constraints[0].requires.payment_route = "upi_intent_v3"; m.constraints[1].forbids.payment_route = "upi_intent_v3"; m.experiment.environment = "staging"; }));
    assert.equal(v2.json.status, "created");
    assert.ok(v2.json.drift.some((d: any) => d.attribute === "experiment.environment" && d.severity === "error"));
    assert.ok(v2.json.drift.some((d: any) => d.attribute === "variant.upi_first.payment_route"));

    assert.deepEqual((await call("GET", "/api/contracts/checkout-journey")).json.versions, [1, 2]);
    const old = (await call("GET", "/api/contracts/checkout-journey/versions/1")).json.contract;
    assert.equal(old.variants.upi_first.payment_route, "upi_intent_v2", "v1 is unchanged");
    const findings = (await call("GET", "/api/contracts/checkout-journey/findings?version=1")).json.findings;
    assert.ok(findings.length > 0 && findings.every((f: any) => f.contractVersion === 1), "historical findings stay attached to v1");
    const again = await report("checkout-journey", "?version=1");
    assert.equal(again.report.status, "CONTRACT_VIOLATION", "evaluating v1 still uses the v1 contract");
    const v2report = await report("checkout-journey", "?version=2");
    assert.equal(v2report.report.version, 2);
    assert.ok(v2report.report.findings.some((f: any) => f.code === "CONTRACT_VERSION_MISMATCH" || f.code === "ENVIRONMENT_MISMATCH"));
  });
});

describe("contracts API: simulation scenarios", () => {
  it("scenarios__each_produces_its_expected_finding_and_is_labelled_simulation", async () => {
    const list = (await call("GET", "/api/contract-scenarios")).json;
    assert.equal(list.scenarios.length, 5);
    for (const s of list.scenarios) {
      const r = await call("POST", `/api/simulate/contract/${s.id}`);
      assert.equal(r.status, 200, s.id);
      assert.equal(r.json.observedCode, s.expectedCode, `${s.id}: ${JSON.stringify(r.json.report.findings.slice(0, 3).map((f: any) => f.code))}`);
      assert.equal(r.json.matched, true);
      assert.match(r.json.label, /SIMULATION/);
    }
  });

  it("scenarios__valid_has_four_compliant_surfaces_and_invalid_names_the_violating_ones", async () => {
    const valid = (await call("POST", "/api/simulate/contract/valid")).json.report;
    assert.ok(valid.surfaces.every((s: any) => s.status === "compliant"));
    const bad = (await call("POST", "/api/simulate/contract/invalid-combination")).json.report;
    assert.deepEqual(bad.surfaces.filter((s: any) => s.status === "violating").map((s: any) => s.id).sort(), ["payment-api", "risk-engine"]);
  });

  it("report__observed_combinations__group_subjects_and_explain_invalid_ones", async () => {
    const r = (await call("POST", "/api/simulate/contract/invalid-combination")).json;
    const rep = (await report("sim-checkout-journey"));
    const invalid = rep.observedCombinations.filter((c: any) => c.status === "invalid");
    const valid = rep.observedCombinations.filter((c: any) => c.status === "valid");
    assert.ok(invalid.length >= 1 && valid.length >= 1);
    assert.equal(invalid[0].variant, "upi_first");
    assert.deepEqual(invalid[0].features, { checkout_ui: "upi_first", payment_route: "legacy", retry_policy: "standard" });
    assert.ok(invalid[0].constraintIds.includes("upi-needs-v2-route"));
    assert.ok(invalid[0].reasons.some((m: string) => /payment_route is legacy but variant "upi_first" requires upi_intent_v2/.test(m)) && invalid[0].reasons.some((m: string) => /only safe with the v2 UPI intent route/.test(m)));
    assert.equal(invalid.reduce((n: number, c: any) => n + c.subjects, 0) + valid.reduce((n: number, c: any) => n + c.subjects, 0), r.report.subjects.length);
    assert.equal(rep.combinationMatrix.features.length, 3);
  });

  it("scenarios__real_surfaces_cannot_write_into_the_simulated_contract", async () => {
    await call("POST", "/api/simulate/contract/valid");
    const id = await identity("cust-30");
    const r = await call("POST", "/api/contract-observations", { observations: surfaceObs(id, "real-into-sim", "control", {}, "sim-checkout-journey") }, asIngest);
    assert.match(JSON.stringify(r.json.results), /simulation; real surfaces cannot report/);
  });

  it("scenarios__rerun_resets_only_the_simulated_contract", async () => {
    await call("POST", "/api/contracts", manifest());
    const id = await identity("cust-31");
    await call("POST", "/api/contract-observations", { observations: surfaceObs(id, "keep", "control") }, asIngest);
    await call("POST", "/api/simulate/contract/valid");
    await call("POST", "/api/simulate/contract/invalid-combination");
    assert.equal(app.ctx.db.get("SELECT COUNT(*) AS n FROM contract_observations WHERE contract_id = 'checkout-journey'")?.n, 4);
    assert.equal(app.ctx.db.all("SELECT 1 FROM contracts WHERE contract_id = 'sim-checkout-journey'").length, 1);
  });
});
