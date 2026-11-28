import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { loadConfig } from "../apps/api/src/config.ts";
import { Db } from "../apps/api/src/db.ts";
import { createApp, type App } from "../apps/api/src/app.ts";

process.env.VARIANTSHIELD_LOG = "off";
const ADMIN = "ui-admin-token-0123456789";
const SHOTS = resolve(import.meta.dirname, "../docs/screenshots");
let app: App, base: string, browser: Browser;
const problems: string[] = [];
const contexts: BrowserContext[] = [];

beforeEach(async () => {
  const cfg = loadConfig({ VARIANTSHIELD_ADMIN_TOKEN: ADMIN, VARIANTSHIELD_INGEST_KEY: "ui-ingest-key-0123456789", VARIANTSHIELD_IDENTITY_ISSUER_KEY: "ui-issuer-key-0123456789", VARIANTSHIELD_IDENTITY_SECRET: "ui-identity-secret-0123456789abcdef", VARIANTSHIELD_DB_PATH: ":memory:", PORT: "0" });
  app = createApp({ cfg, db: new Db(":memory:"), now: () => Date.now(), flagsmith: null });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});
afterEach(async () => { for (const c of contexts.splice(0)) await c.close(); await browser.close(); await new Promise<void>((r) => app.server.close(() => r())); app.ctx.db.close(); });

async function signIn(actor: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 }, deviceScaleFactor: 2 });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(base);
  await page.getByLabel("Admin token").fill(ADMIN);
  await page.locator("#actor").fill(actor);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("navigation").getByRole("link", { name: "Decision Ledger" }).click();
  await page.getByRole("heading", { name: "Decision Ledger" }).waitFor();
  return page;
}

describe("Decision Ledger dashboard", () => {
  it("journey__ask_draft_propose_refuse_self_approval_approve_as_another_person_then_see_what_changed", { timeout: 120_000 }, async () => {
    const sim = await (await fetch(`${base}/api/simulate/dangerous-winner`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } })).json() as { plan: { id: number } };
    const planId = sim.plan.id;
    const alice = await signIn("alice");

    // Integrity and empty state
    await alice.locator("#integrity").getByText("LEDGER VERIFIED").waitFor();
    await alice.locator("#official").getByText("No official decision has been recorded").waitFor();

    // The assistant answers from records, cites them, and drafts without recording
    await alice.getByRole("button", { name: "Should we ship this?" }).click();
    await alice.locator("#assistant .answer .draft strong", { hasText: "Draft: PAUSE" }).waitFor();
    await alice.locator("#assistant .cites").getByText("fact: verdict.outcome").waitFor();
    assert.equal((await (await fetch(`${base}/api/ledger?kind=decision.proposed`, { headers: { authorization: `Bearer ${ADMIN}` } })).json() as any).entries.length, 0, "asking must not record anything");
    await alice.screenshot({ path: resolve(SHOTS, "ledger-01-assistant.png") });

    // Use the draft as a proposal and record it
    await alice.getByRole("button", { name: "Use as proposal" }).click();
    assert.equal(await alice.locator("#decision").inputValue(), "pause");
    assert.match(await alice.locator("#rationale").inputValue(), /Pause:/);
    await alice.locator("#propose").click();
    await alice.locator("#pending").getByText(/by alice/).waitFor();

    // The proposer cannot approve their own decision
    await alice.locator("#pending").getByRole("button", { name: "Approve…" }).click();
    const dlg = alice.getByRole("dialog");
    await dlg.locator("#confirm").fill("APPROVE 1");
    await dlg.locator("#reason").fill("Looks right to me");
    await dlg.locator("#resolve").click();
    await dlg.getByRole("alert").getByText(/self_approval_forbidden/).waitFor();
    await dlg.getByRole("button", { name: "Cancel" }).click();

    // A different person approves with the typed confirmation
    const bob = await signIn("bob");
    await bob.locator("#pending").getByRole("button", { name: "Approve…" }).click();
    const bdlg = bob.getByRole("dialog");
    await bdlg.locator("#confirm").fill("approve");
    await bdlg.locator("#reason").fill("Reviewed the evidence");
    await bdlg.locator("#resolve").click();
    await bdlg.getByRole("alert").getByText(/confirmation_required/).waitFor();
    await bdlg.locator("#confirm").fill("APPROVE 1");
    await bdlg.locator("#resolve").click();
    await bob.locator("#official").getByText(/approved by bob/).waitFor();
    await bob.locator("#official").getByText("PAUSE", { exact: true }).waitFor();
    await bob.screenshot({ path: resolve(SHOTS, "ledger-02-official-decision.png") });

    // Facts change after the decision: it shows up, and the ledger still verifies
    await fetch(`${base}/api/plans/${planId}/approval`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ decision: "approved", note: "Plan approved later" }) });
    await bob.reload();
    await bob.getByRole("heading", { name: "Decision Ledger" }).waitFor();
    await bob.locator("#changes").getByRole("cell", { name: "planApproval" }).waitFor();
    await bob.locator("#questions").getByText(/changed since the official decision/).waitFor();
    await bob.getByRole("button", { name: "What changed since the last decision?" }).click();
    await bob.locator("#assistant .answer").getByText(/planApproval/).waitFor();
    await bob.getByLabel("Question").fill("is the ledger intact?");
    await bob.locator("#ask").click();
    await bob.locator("#assistant .answer").getByText(/The ledger verifies/).first().waitFor();
    await bob.locator("#timeline").getByRole("cell", { name: "decision.approved" }).waitFor();
    await bob.screenshot({ path: resolve(SHOTS, "ledger-03-changes-and-timeline.png"), fullPage: true });

    // Layout: no horizontal scroll on a phone
    await bob.setViewportSize({ width: 390, height: 844 });
    assert.ok(await bob.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal page scroll at 390px");
    assert.deepEqual(problems.filter((p) => !/status of (400|401|403|409)/.test(p)), [], "no console errors or CSP violations");
  });
});
