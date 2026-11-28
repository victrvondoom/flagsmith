import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { loadConfig } from "../apps/api/src/config.ts";
import { Db } from "../apps/api/src/db.ts";
import { createApp, type App } from "../apps/api/src/app.ts";

process.env.VARIANTSHIELD_LOG = "off";
const ADMIN = "ui-admin-token-0123456789";
const SHOTS = resolve(import.meta.dirname, "../docs/screenshots");
let app: App, base: string, browser: Browser;
const problems: string[] = [];

before(async () => {
  const cfg = loadConfig({ VARIANTSHIELD_ADMIN_TOKEN: ADMIN, VARIANTSHIELD_INGEST_KEY: "ui-ingest-key-0123456789", VARIANTSHIELD_IDENTITY_ISSUER_KEY: "ui-issuer-key-0123456789", VARIANTSHIELD_IDENTITY_SECRET: "ui-identity-secret-0123456789abcdef", VARIANTSHIELD_DB_PATH: ":memory:", PORT: "0" });
  app = createApp({ cfg, db: new Db(":memory:"), now: () => Date.now(), flagsmith: null });
  app.ctx.bisect!.start(60);
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});
after(async () => { app.ctx.bisect!.stop(); await browser.close(); app.server.closeAllConnections(); await new Promise<void>((r) => app.server.close(() => r())); app.ctx.db.close(); });

async function signIn(actor: string, width = 1440): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: width < 500 ? 1 : 2 });
  const page = await ctx.newPage();
  // The 400 (wrong confirmation) and 403 (self-approval) responses below are provoked on purpose.
  page.on("console", (m) => { if (m.type() === "error" && !/status of (400|403) /.test(m.text())) problems.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(base);
  await page.getByLabel("Admin token").fill(ADMIN);
  await page.locator("#actor").fill(actor);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "Flagsmith connection" }).waitFor();
  await page.getByRole("navigation").getByRole("link", { name: "Incident Room" }).click();
  await page.getByRole("heading", { name: "Incident Room" }).waitFor();
  return page;
}

describe("Incident Room journey", () => {
  it("simulated_incident__two_people_through_both_gates__ends_resolved_with_live_updates", async () => {
    const alice = await signIn("alice");
    await alice.getByRole("button", { name: "Simulate: One bad model rollout" }).click();
    await alice.locator(".live[data-state='live']").waitFor({ timeout: 10_000 });
    // The swarm opens the incident and stops at gate 1 without any click: the page updates from the stream.
    await alice.getByRole("heading", { name: "Approve the envelope" }).waitFor({ timeout: 30_000 });
    await alice.locator(".hero .chip", { hasText: "AWAITING APPROVAL" }).waitFor();
    assert.equal(await alice.locator(".suspect").count(), 7);
    await alice.screenshot({ path: `${SHOTS}/incident-01-awaiting-approval.png`, fullPage: true });
    const confirm = await alice.locator("#env-confirm").getAttribute("placeholder");
    await alice.locator("#env-confirm").fill("BISECT 0");
    await alice.locator("#env-reason").fill("10% canary is acceptable");
    await alice.getByRole("button", { name: "Approve and start probing" }).click();
    await alice.getByRole("alert").filter({ hasText: "confirmation_required" }).waitFor();
    await alice.locator("#env-confirm").fill(confirm!);
    await alice.getByRole("button", { name: "Approve and start probing" }).click();
    await alice.locator(".probe").first().waitFor({ timeout: 30_000 });
    await alice.getByRole("heading", { name: "Propose the remediation" }).waitFor({ timeout: 120_000 });
    await alice.locator(".headline", { hasText: "recs_model" }).waitFor();
    await alice.screenshot({ path: `${SHOTS}/incident-02-identified.png`, fullPage: true });
    await alice.locator("#rem-reason").fill("Roll the recommendations model back to 2026-10");
    // On a slow network, a read of the incident that left before the proposal can answer
    // after it. Hold one back and release it once the next form is filled in: the page must
    // not draw that older state over the newer one and lose what was typed.
    const held: { release?: () => Promise<void> } = {};
    const incidentRead = /\/api\/incidents\/\d+$/;
    await alice.route(incidentRead, async (route) => {
      if (held.release || route.request().method() !== "GET") return route.continue();
      const stale = await route.fetch();
      held.release = () => route.fulfill({ response: stale });
    });
    for (let waited = 0; !held.release && waited < 10_000; waited += 50) await alice.waitForTimeout(50);
    assert.ok(held.release, "the live stream refreshed the incident");
    await alice.getByRole("button", { name: "Propose remediation" }).click();
    await alice.getByRole("heading", { name: "Second-person approval" }).waitFor();
    // The proposer cannot approve.
    const conf2 = await alice.locator("#rem-confirm").getAttribute("placeholder");
    await alice.locator("#rem-confirm").fill(conf2!);
    await alice.locator("#rem-approve-reason").fill("approving my own proposal");
    await held.release();
    await alice.unroute(incidentRead);
    await alice.waitForTimeout(1_500); // long enough for the stale answer and the next refresh to draw
    assert.equal(await alice.locator("#rem-confirm").inputValue(), conf2, "what was typed survives a late answer");
    await alice.getByRole("button", { name: "Approve and apply" }).click();

    await alice.getByRole("alert").filter({ hasText: "self_approval_forbidden" }).waitFor();
    // A second person approves from their own session.
    const bob = await signIn("bob");
    await bob.getByRole("heading", { name: "Second-person approval" }).waitFor();
    await bob.locator("#rem-confirm").fill(conf2!);
    await bob.locator("#rem-approve-reason").fill("Checked the confirmation probe");
    await bob.getByRole("button", { name: "Approve and apply" }).click();
    await bob.locator(".hero .chip", { hasText: /REMEDIATED|RESOLVED/ }).waitFor({ timeout: 20_000 });
    await bob.locator(".hero .chip", { hasText: "RESOLVED" }).waitFor({ timeout: 60_000 });
    await bob.screenshot({ path: `${SHOTS}/incident-03-resolved.png`, fullPage: true });
    // Alice's page followed along without a reload.
    await alice.locator(".hero .chip", { hasText: "RESOLVED" }).waitFor({ timeout: 10_000 });
    const phone = await signIn("carol", 390);
    await phone.locator(".hero").waitFor();
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, "no horizontal scroll at 390 px");
    await phone.screenshot({ path: `${SHOTS}/incident-04-phone.png`, fullPage: false });
    assert.deepEqual(problems, []);
  });
});
