import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { loadConfig } from "../apps/api/src/config.ts";
import { Db } from "../apps/api/src/db.ts";
import { createApp, type App } from "../apps/api/src/app.ts";
import { buildFlagsmith } from "../apps/api/src/context.ts";
import { SAMPLE_EXPERIMENT, sampleResultsPayload, startFakeFlagsmith, type FakeFlagsmith } from "../packages/flagsmith-adapter/src/testing/fake-flagsmith.ts";

process.env.VARIANTSHIELD_LOG = "off";
const SHOTS = resolve(import.meta.dirname, "../docs/screenshots");
const ADMIN = "ui-admin-token-0123456789";
let fake: FakeFlagsmith, app: App, base: string, browser: Browser, page: Page;
const problems: string[] = [];

beforeEach(async () => {
  fake = await startFakeFlagsmith({ experiments: [SAMPLE_EXPERIMENT] });
  fake.results.set(7, sampleResultsPayload());
  const cfg = loadConfig({ VARIANTSHIELD_ADMIN_TOKEN: ADMIN, VARIANTSHIELD_INGEST_KEY: "ui-ingest-key-0123456789", VARIANTSHIELD_DB_PATH: ":memory:", PORT: "0", FLAGSMITH_URL: fake.url, FLAGSMITH_ENVIRONMENT_KEY: fake.environmentKey, FLAGSMITH_ADMIN_API_KEY: fake.adminKey, VARIANTSHIELD_BENCH_DIR: resolve(import.meta.dirname, "../data/ui-bench") });
  app = createApp({ cfg, db: new Db(":memory:"), now: () => Date.now(), flagsmith: buildFlagsmith(cfg) });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2 });
  page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error" && !/status of 401/.test(m.text())) problems.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
});
afterEach(async () => { await browser.close(); await new Promise<void>((r) => app.server.close(() => r())); app.ctx.db.close(); await fake.close(); });

const shot = (name: string): Promise<unknown> => page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
const nav = (label: string): Promise<void> => page.getByRole("navigation").getByRole("link", { name: label }).click();

describe("dashboard in a real browser", () => {
  it("full_journey__login_simulate_verdict_bench_pause", { timeout: 120_000 }, async () => {
    await page.goto(base);
    // Wrong token is refused.
    await page.getByLabel("Admin token").fill("wrong-token-value-0000");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("alert").filter({ hasText: "not accepted" }).waitFor();
    await page.getByLabel("Admin token").fill(ADMIN);
    await page.getByLabel("Actor name").fill("Sam Reviewer");
    await page.getByRole("button", { name: "Sign in" }).click();

    // Command Center with the real (double) Flagsmith connection.
    await page.getByRole("heading", { name: "Flagsmith connection" }).waitFor();
    await page.getByText("Flagsmith Management API reachable").waitFor({ state: "visible", timeout: 5000 });
    await page.getByRole("button", { name: "Import experiments from Flagsmith" }).click();
    await page.getByText("Imported 1 experiment").waitFor();
    await shot("01-command-center");

    // Scenario A then B.
    await page.getByRole("button", { name: "Run safe winner" }).click();
    await page.getByText("is operationally healthy on the measured guardrails").waitFor();
    await shot("05-verdict-safe-winner");
    await nav("Command Center");
    await page.getByRole("button", { name: "Run dangerous winner" }).click();
    await page.getByText("breaches reliability guardrails. Do not ship.").waitFor();
    await page.locator(".chip", { hasText: "WINNER BUT UNSAFE" }).first().waitFor({ state: "visible", timeout: 5000 });
    await page.getByText("payment_failure_rate: BREACH").first().waitFor({ state: "visible", timeout: 5000 });
    await shot("05-verdict-dangerous-winner");

    // Observatory.
    await nav("Reliability Observatory");
    await page.getByRole("heading", { name: "upi_first" }).waitFor();
    await page.locator(".banner .chip", { hasText: "SIMULATION" }).first().waitFor({ state: "visible", timeout: 5000 });
    await shot("04-reliability-observatory");

    // Board shows the simulated plan in BREACH, the imported real plan in RUNNING.
    await nav("Trial Board");
    await page.getByRole("region", { name: "BREACH" }).getByText("[SIMULATION] Checkout flow: Dangerous winner").waitFor();
    await page.getByRole("region", { name: "RUNNING" }).getByText("Checkout flow", { exact: true }).waitFor();
    await shot("02-trial-board");

    // Variant Bench: real Playwright run started from the UI with an injected fault.
    await nav("Variant Bench");
    await page.getByLabel("Fault").selectOption("duplicate_submissions");
    await page.getByRole("button", { name: "Run Playwright suite" }).click();
    await page.getByText("Bench started").waitFor();
    for (let i = 0; i < 90; i++) {
      const runs = (await (await fetch(`${base}/api/bench/runs`, { headers: { authorization: `Bearer ${ADMIN}` } })).json() as { runs: { status: string }[] }).runs;
      if (runs[0] && runs[0].status !== "running") { assert.equal(runs[0].status, "failed", "injected fault must fail the suite"); break; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    await page.reload();
    await page.getByRole("heading", { name: "Acceptance matrix" }).waitFor();
    await page.getByRole("button", { name: "upi_first duplicate_submission_prevention: failed" }).click();
    await page.getByRole("img", { name: /upi_first · duplicate_submission_prevention: failed/ }).waitFor();
    await page.getByText("a double click sent 2 payment requests").first().waitFor({ state: "visible", timeout: 5000 });
    await page.waitForFunction(() => [...document.querySelectorAll(".shots img")].every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0));
    await shot("03-variant-bench");

    // Experiment Control on the real linked plan: wrong text blocks, exact text executes, Flagsmith confirms.
    await page.evaluate(() => sessionStorage.removeItem("vs.plan"));
    await nav("Experiment Control");
    await page.getByLabel("Experiment").selectOption({ label: "Checkout flow" });
    await page.getByText("Flagsmith status: running").waitFor();
    await page.getByRole("button", { name: "Dry run" }).first().click();
    await page.getByText("Dry run: nothing changed.").waitFor();
    assert.equal(fake.experiments.get(7)!.status, "running");
    await page.getByRole("button", { name: "Review and confirm…" }).first().click();
    const confirm = page.getByLabel(/Type PAUSE 7 to confirm/);
    const go = page.getByRole("button", { name: "Pause experiment" });
    await confirm.fill("pause");
    await page.getByLabel(/Reason/).fill("upi_first breached payment guardrail");
    assert.ok(await go.isDisabled(), "wrong confirmation text must keep the action disabled");
    await shot("06-experiment-control-confirm");
    await confirm.fill("PAUSE 7");
    await go.click();
    await page.getByText("Before: running → After: paused").waitFor();
    assert.equal(fake.experiments.get(7)!.status, "paused");
    await page.getByText("Flagsmith status: paused").waitFor({ timeout: 5000 });
    await shot("06-experiment-control-paused");
    const audit = (await (await fetch(`${base}/api/audit`, { headers: { authorization: `Bearer ${ADMIN}` } })).json() as { audit: { actor: string; outcome: string }[] }).audit;
    assert.equal(audit[0]!.actor, "Sam Reviewer");
    assert.equal(audit[0]!.outcome, "executed");
    assert.deepEqual(problems, [], "no console errors or CSP violations");
  });

  it("mobile_viewport__has_no_horizontal_page_scroll", async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(base);
    await page.getByLabel("Admin token").fill(ADMIN);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Flagsmith connection" }).waitFor();
    for (const label of ["Command Center", "Reliability Observatory", "Dual Verdict Room"]) {
      await nav(label);
      await page.waitForTimeout(300);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${label} overflows horizontally`);
    }
  });
});
