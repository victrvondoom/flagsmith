import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../apps/api/src/config.ts";
import { Db } from "../apps/api/src/db.ts";
import { createApp, type App } from "../apps/api/src/app.ts";
import { buildFlagsmith } from "../apps/api/src/context.ts";
import { EXAMPLE_MANIFEST } from "../apps/api/src/contract-sim.ts";
import { createSurface, SURFACES } from "../apps/surfaces/src/surface.ts";
import { FlagsmithClient } from "../packages/flagsmith-adapter/src/index.ts";
import { startFakeFlagsmith, type FakeExperiment, type FakeFlagsmith } from "../packages/flagsmith-adapter/src/testing/fake-flagsmith.ts";

process.env.VARIANTSHIELD_LOG = "off";
const ADMIN = "srf-admin-token-0123456789", INGEST = "srf-ingest-key-0123456789", ISSUER = "srf-issuer-key-0123456789", KEY = "srf-control-key-0123456789";
const FLAG: FakeExperiment = { id: 9, name: "Checkout journey", hypothesis: "", status: "running", featureName: "checkout_journey_variant", variants: ["control", "upi_first"], weights: { control: 0.5, upi_first: 0.5 } };
let fake: FakeFlagsmith, api: App, apiUrl: string;
let surfaces: { id: string; url: string; close: () => Promise<void> }[] = [];
const bySurface = (id: string): string => surfaces.find((s) => s.id === id)!.url;

const adminCall = async (method: string, path: string, body?: unknown): Promise<any> => (await fetch(apiUrl + path, { method, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
const issue = async (customer: string): Promise<{ subjectRef: string; token: string }> => (await fetch(`${apiUrl}/api/identity/issue`, { method: "POST", headers: { "x-identity-issuer-key": ISSUER, "content-type": "application/json" }, body: JSON.stringify({ subject: customer }) })).json() as any;
const resolveAll = async (token: string): Promise<any[]> => Promise.all(surfaces.map(async (s) => (await fetch(`${s.url}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identityToken: token }) })).json()));
const fault = (id: string, body: unknown | null): Promise<Response> => fetch(`${bySurface(id)}/__config`, { method: body ? "PUT" : "DELETE", headers: { "x-surface-key": KEY, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

beforeEach(async () => {
  fake = await startFakeFlagsmith({ experiments: [FLAG] });
  const cfg = loadConfig({ VARIANTSHIELD_ADMIN_TOKEN: ADMIN, VARIANTSHIELD_INGEST_KEY: INGEST, VARIANTSHIELD_IDENTITY_ISSUER_KEY: ISSUER, VARIANTSHIELD_IDENTITY_SECRET: "srf-identity-secret-0123456789abcdef", VARIANTSHIELD_DB_PATH: ":memory:", PORT: "0", FLAGSMITH_URL: fake.url, FLAGSMITH_ENVIRONMENT_KEY: fake.environmentKey, FLAGSMITH_ADMIN_API_KEY: fake.adminKey });
  api = createApp({ cfg, db: new Db(":memory:"), now: () => Date.now(), flagsmith: buildFlagsmith(cfg) });
  await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  assert.equal((await adminCall("POST", "/api/contracts", parseYaml(readFileSync(EXAMPLE_MANIFEST, "utf8")))).status, "created");
  surfaces = [];
  for (const def of SURFACES) {
    const { server } = createSurface({ def, flagsmith: new FlagsmithClient({ baseUrl: fake.url, environmentKey: fake.environmentKey }), environmentKey: fake.environmentKey, environmentName: "production", variantshieldUrl: apiUrl, ingestKey: INGEST, contractId: "checkout-journey", contractVersion: 1, experimentKey: "checkout_journey", assignmentFlag: "checkout_journey_variant", controlKey: KEY });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    surfaces.push({ id: def.id, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(() => r())) });
  }
});
afterEach(async () => { await Promise.all(surfaces.map((s) => s.close())); await new Promise<void>((r) => api.server.close(() => r())); api.ctx.db.close(); await fake.close(); });

describe("four sample surfaces against the Flagsmith double", () => {
  it("valid__every_surface_uses_the_canonical_subject_and_flagsmiths_assignment__contract_is_valid", async () => {
    const customers = Array.from({ length: 12 }, (_, i) => `customer-${i}`);
    const seen = new Set<string>();
    for (const c of customers) {
      const id = await issue(c);
      const results = await resolveAll(id.token);
      assert.ok(results.every((r) => r.subjectRef === id.subjectRef), "one canonical subject on all four surfaces");
      assert.equal(new Set(results.map((r) => r.assignedVariant)).size, 1, "Flagsmith gives the same variant to every surface");
      assert.ok(results.every((r) => r.assignedVariant === r.flagsmithVariant));
      seen.add(results[0].assignedVariant);
    }
    assert.equal(seen.size, 2, "both variants occurred");
    const check = await adminCall("POST", "/api/contracts/checkout-journey/check");
    assert.equal(check.report.status, "CONTRACT_VALID", JSON.stringify(check.report.findings.slice(0, 3)));
    assert.equal(check.flagsmith.verified, true);
    assert.equal(check.report.subjects.length, customers.length);
  });

  it("surface_returns_each_surfaces_own_resolved_features", async () => {
    const id = await issue("grace-7");
    const r = await resolveAll(id.token);
    const v = r[0].assignedVariant;
    const expected: Record<string, Record<string, string>> = { control: { checkout_ui: "classic", payment_route: "legacy", retry_policy: "standard" }, upi_first: { checkout_ui: "upi_first", payment_route: "upi_intent_v2", retry_policy: "bounded" } };
    assert.deepEqual(Object.assign({}, ...r.map((x) => x.features)), expected[v]);
  });

  it("invalid_combination__payment_api_legacy_and_risk_standard_for_a_upi_subject__is_detected_end_to_end", async () => {
    await fault("payment-api", { featureOverrides: { payment_route: "legacy" } });
    await fault("risk-engine", { featureOverrides: { retry_policy: "standard" } });
    let upi = 0;
    for (let i = 0; i < 12 && upi < 3; i++) { const id = await issue(`heidi-${i}`); const r = await resolveAll(id.token); if (r[0].assignedVariant === "upi_first") upi++; }
    assert.ok(upi >= 1, "need at least one upi_first subject");
    const check = await adminCall("POST", "/api/contracts/checkout-journey/check");
    assert.equal(check.report.status, "CONTRACT_VIOLATION");
    assert.equal(check.report.primaryCode, "COMBINATION_VIOLATION");
    const states = Object.fromEntries(check.report.surfaces.map((s: any) => [s.id, s.status]));
    assert.equal(states["web-checkout"], "compliant");
    assert.equal(states["payment-api"], "violating");
    assert.equal(states["risk-engine"], "violating");
    assert.equal((await fault("payment-api", null)).status, 200);
  });

  it("assignment_mismatch__a_surface_reporting_a_stale_variant__is_detected_against_flagsmith_itself", async () => {
    await fault("mobile-checkout", { reportVariant: "control" });
    let hit = false;
    for (let i = 0; i < 12 && !hit; i++) { const id = await issue(`ivan-${i}`); const r = await resolveAll(id.token); hit = r.find((x) => x.surface === "mobile-checkout").flagsmithVariant === "upi_first"; }
    assert.ok(hit);
    const check = await adminCall("POST", "/api/contracts/checkout-journey/check");
    assert.equal(check.report.primaryCode, "ASSIGNMENT_MISMATCH");
    assert.ok(check.report.findings.some((f: any) => f.code === "ASSIGNMENT_MISMATCH" && f.evidence.source === "flagsmith_reverify" && f.surfaceId === "mobile-checkout"));
  });

  it("environment_mismatch__surface_pointed_at_staging__is_detected", async () => {
    await fault("payment-api", { environmentName: "staging" });
    await resolveAll((await issue("judy-1")).token);
    const check = await adminCall("POST", "/api/contracts/checkout-journey/check");
    assert.equal(check.report.primaryCode, "ENVIRONMENT_MISMATCH");
  });

  it("identity_unlinked__surface_that_drops_the_token__is_reported_not_guessed", async () => {
    await fault("web-checkout", { dropIdentity: true });
    await resolveAll((await issue("kate-1")).token);
    const check = await adminCall("POST", "/api/contracts/checkout-journey/check");
    assert.ok(check.report.findings.some((f: any) => f.code === "IDENTITY_UNLINKED" && f.surfaceId === "web-checkout"));
    assert.equal(check.report.unlinkedObservations, 1);
  });

  it("forged_token__surface_cannot_resolve_an_assignment_and_the_observation_is_unlinked", async () => {
    const id = await issue("leo-1");
    const forged = id.token.slice(0, -4) + "AAAA";
    const r = await resolveAll(forged);
    assert.ok(r.every((x) => x.subjectRef === null && x.assignedVariant === null && /identity_bad_signature/.test(x.assignmentNote)));
    assert.equal((await adminCall("GET", "/api/contracts/checkout-journey/report")).report.subjects.length, 0);
  });

  it("surface_fault_endpoint__requires_the_control_key", async () => {
    const r = await fetch(`${bySurface("risk-engine")}/__config`, { method: "PUT", headers: { "x-surface-key": "wrong" }, body: "{}" });
    assert.equal(r.status, 401);
  });
});
