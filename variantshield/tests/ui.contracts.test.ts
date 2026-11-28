import { postAsSurfaces } from "../apps/api/src/testing/observations.ts";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../apps/api/src/config.ts";
import { Db } from "../apps/api/src/db.ts";
import { createApp, type App } from "../apps/api/src/app.ts";
import { buildFlagsmith } from "../apps/api/src/context.ts";
import { EXAMPLE_MANIFEST } from "../apps/api/src/contract-sim.ts";
import { startFakeFlagsmith, type FakeFlagsmith } from "../packages/flagsmith-adapter/src/testing/fake-flagsmith.ts";

process.env.VARIANTSHIELD_LOG = "off";
const SHOTS = resolve(import.meta.dirname, "../docs/screenshots");
const ADMIN = "ui-admin-token-0123456789", INGEST = "ui-ingest-key-0123456789", ISSUER = "ui-issuer-key-0123456789";
let fake: FakeFlagsmith, app: App, base: string, browser: Browser, page: Page;
const problems: string[] = [];

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${ADMIN}` }): Promise<any> =>
  (await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
const FEATS: Record<string, Record<string, string>> = { control: { checkout_ui: "classic", payment_route: "legacy", retry_policy: "standard" }, upi_first: { checkout_ui: "upi_first", payment_route: "upi_intent_v2", retry_policy: "bounded" } };
const SURF: Record<string, string> = { "web-checkout": "checkout_ui", "mobile-checkout": "checkout_ui", "payment-api": "payment_route", "risk-engine": "retry_policy" };
async function report(customer: string, variant: string, over: Record<string, Record<string, string>> = {}): Promise<string> {
  const id = await api("POST", "/api/identity/issue", { subject: customer }, { "x-identity-issuer-key": ISSUER });
  const observations = Object.entries(SURF).map(([surfaceId, f]) => ({ observationId: `${customer}-${surfaceId}`, contractId: "checkout-journey", contractVersion: 1, experimentKey: "checkout_journey", environment: "production", envFingerprint: "aaaaaaaaaaaaaaaa", assignmentFlag: "checkout_journey_variant", assignedVariant: variant, surfaceId, identityToken: id.token, observedAt: Date.now() - 20_000, features: { [f]: over[surfaceId]?.[f] ?? FEATS[variant]![f] } }));
  await postAsSurfaces(base, INGEST, { observations });
  return id.subjectRef;
}

beforeEach(async () => {
  fake = await startFakeFlagsmith();
  const cfg = loadConfig({ VARIANTSHIELD_ADMIN_TOKEN: ADMIN, VARIANTSHIELD_INGEST_KEY: INGEST, VARIANTSHIELD_IDENTITY_ISSUER_KEY: ISSUER, VARIANTSHIELD_IDENTITY_SECRET: "ui-identity-secret-0123456789abcdef", VARIANTSHIELD_DB_PATH: ":memory:", PORT: "0" });
  app = createApp({ cfg, db: new Db(":memory:"), now: () => Date.now(), flagsmith: buildFlagsmith(cfg) });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2 })).newPage();
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
});
afterEach(async () => { await browser.close(); await new Promise<void>((r) => app.server.close(() => r())); app.ctx.db.close(); await fake.close(); });

const shot = (name: string): Promise<unknown> => page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
const tab = (name: string | RegExp): Promise<void> => page.getByRole("tab", { name }).click();

describe("Cross-Surface Contracts dashboard", () => {
  it("journey__register_ingest_violation_matrix_combinations_evidence_drift_and_scenarios", { timeout: 120_000 }, async () => {
    await page.goto(base);
    await page.getByLabel("Admin token").fill(ADMIN);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("navigation").getByRole("link", { name: "Cross-Surface Contracts" }).click();
    await page.getByRole("heading", { name: "No contracts yet" }).waitFor();

    // Editor: invalid manifest is explained; the example validates and registers.
    await page.getByText("Contract manifest editor").click();
    await page.getByLabel("Contract manifest").fill("contract:\n  id: Bad Id\nsurfaces: []\n");
    await page.getByRole("button", { name: "Validate" }).click();
    await page.getByText(/problem\(s\):/).waitFor();
    assert.ok(await page.getByText("must match", { exact: false }).first().isVisible());
    await page.getByRole("button", { name: "Load example" }).click();
    await page.getByRole("button", { name: "Validate" }).click();
    await page.getByText("Valid: checkout-journey v1, 4 surfaces, 2 variants.").waitFor();
    await page.getByRole("button", { name: "Register version" }).click();
    await page.getByRole("heading", { name: "Registered surfaces" }).waitFor();
    await page.locator(".banner .chip", { hasText: "NO DATA" }).first().waitFor();

    // Real data arrives through the ingest API: three valid subjects, one violating subject.
    await report("alice", "control"); await report("bob", "upi_first");
    const bad = await report("carol", "upi_first", { "payment-api": { payment_route: "legacy" }, "risk-engine": { retry_policy: "standard" } });
    await page.reload();
    await page.locator(".banner .chip", { hasText: "COMBINATION_VIOLATION" }).first().waitFor();
    await page.getByRole("row", { name: /payment-api/ }).getByText("violating").waitFor();
    await page.getByRole("row", { name: /web-checkout/ }).getByText("compliant").waitFor();
    await shot("contracts-01-overview");

    // Surface assignment matrix.
    await tab("Surface assignment matrix");
    await page.getByRole("heading", { name: "Surface assignment comparison" }).waitFor();
    for (const col of ["Surface", "Identity", "Environment", "Variant", "Assignment status"]) await page.getByRole("columnheader", { name: col, exact: true }).waitFor();
    await page.getByText(bad.slice(0, 9), { exact: false }).first().waitFor();
    await shot("contracts-02-surface-matrix");

    // Feature combination matrix: expected table, the broken combination and why.
    await tab("Feature combination matrix");
    await page.getByRole("heading", { name: "Expected configuration per variant" }).waitFor();
    const expected = page.locator(".card", { has: page.getByRole("heading", { name: "Expected configuration per variant" }) });
    await expected.getByRole("row", { name: /payment_route.*legacy.*upi_intent_v2.*payment-api/ }).waitFor();
    const invalid = page.getByRole("row", { name: /upi_first.*payment_route=legacy/ });
    await invalid.getByText("invalid").waitFor();
    assert.ok(await invalid.getByText(/payment_route is legacy but variant "upi_first" requires upi_intent_v2/).first().isVisible());
    await shot("contracts-03-combination-matrix");

    // Evidence: current findings, record history with a check, open one.
    await tab("Contract evidence");
    await page.getByRole("heading", { name: /Current evaluation/ }).waitFor();
    await page.getByRole("row", { name: /payment-api.*COMBINATION_VIOLATION.*legacy.*upi_intent_v2/ }).first().click();
    await page.getByRole("dialog", { name: "Finding evidence" }).getByText("COMBINATION_VIOLATION").waitFor();
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await tab("Overview");
    await page.getByRole("button", { name: /Run check/ }).click();
    await page.getByText(/Check complete: \d+ new finding/).waitFor();
    await tab("Contract evidence");
    await page.getByRole("heading", { name: /Recorded history for v1 \([1-9]/ }).waitFor();
    await page.getByRole("cell", { name: /^finding:\d+$/ }).first().waitFor();
    await shot("contracts-05-evidence");

    // Version 2 changes the contract; drift is recorded and v1 stays available.
    const v2 = parseYaml(readFileSync(EXAMPLE_MANIFEST, "utf8")); v2.contract.version = 2; v2.experiment.environment = "staging"; v2.freshness.max_age_seconds = 600;
    await api("POST", "/api/contracts", v2);
    await page.reload();
    await tab("Contract drift");
    await page.getByRole("heading", { name: "Detected changes" }).waitFor();
    const envRow = page.getByRole("row", { name: /experiment\.environment.*production.*staging/ });
    await envRow.waitFor();
    assert.ok(await envRow.getByText("error").isVisible());
    await page.getByRole("row", { name: /v1.*historical/ }).waitFor();
    await shot("contracts-04-drift");
    await page.getByLabel("Version").selectOption("1");
    await tab("Contract evidence");
    await page.getByRole("heading", { name: /Recorded history for v1/ }).waitFor();

    // Scenarios: assignment mismatch and valid, straight from the UI.
    await page.getByRole("tab", { name: "Overview" }).click();
    await page.getByRole("button", { name: "Simulate: Assignment mismatch" }).click();
    await page.getByText("expected ASSIGNMENT_MISMATCH, observed ASSIGNMENT_MISMATCH").waitFor();
    await page.locator(".banner .chip", { hasText: "ASSIGNMENT_MISMATCH" }).first().waitFor();
    assert.ok(await page.locator(".banner .chip", { hasText: "SIMULATION" }).first().isVisible());
    await tab("Surface assignment matrix");
    await page.getByRole("cell", { name: "MISMATCH", exact: true }).first().waitFor();
    await shot("contracts-06-assignment-mismatch-simulation");
    await tab("Overview");
    await page.getByRole("button", { name: "Simulate: Valid contract" }).click();
    await page.getByText("expected CONTRACT_VALID, observed CONTRACT_VALID").waitFor();
    await page.locator(".banner .chip", { hasText: "CONTRACT VALID" }).first().waitFor();
    assert.equal(await page.getByRole("row", { name: /compliant/ }).count(), 4);
    await shot("contracts-07-valid-simulation");
    // Integration page: wiring is visible, secret values never are.
    await page.goto(`${base}/#/integration`);
    await page.getByRole("heading", { name: "Flagsmith connection" }).waitFor();
    await page.getByRole("heading", { name: "Secrets (values hidden)" }).waitFor();
    await page.getByRole("heading", { name: "Endpoints for your services" }).waitFor();
    assert.ok(!(await page.locator("main").innerText()).includes(ADMIN), "admin token is not rendered");
    await shot("integration-01-config");
    assert.deepEqual(problems.filter((p) => !/status of 401/.test(p)), [], "no console errors or CSP violations");
  });
});
