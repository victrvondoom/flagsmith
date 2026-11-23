import assert from "node:assert/strict";
import type { Browser, Page } from "playwright";

/** The same acceptance suite runs against every variant. */
export interface Harness {
  browser: Browser;
  baseUrl: string;
  variant: string;
  /** Applies a fault to this variant (or clears it) on the demo under test. */
  setFault(type: string | null, rate?: number): Promise<void>;
}

export interface TestDef {
  name: string;
  run(page: Page, h: Harness): Promise<void>;
}

const payRequests = (page: Page): { bodies: string[] } => {
  const bodies: string[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/pay") && r.method() === "POST") bodies.push(r.postData() ?? ""); });
  return { bodies };
};
const complete = (page: Page) => page.getByTestId("status").filter({ hasText: "Payment complete" });

export const SUITE: TestDef[] = [
  {
    name: "form_integrity",
    async run(page, h) {
      const form = page.getByTestId("checkout-form");
      await form.waitFor();
      assert.equal(await form.getAttribute("data-variant"), h.variant, "page rendered a different variant than requested");
      assert.ok(await page.getByTestId("pay").isEnabled(), "pay button must be enabled");
      assert.match((await page.getByTestId("pay").textContent()) ?? "", /Pay ₹1,499/);
      const inputs = await page.locator("form input").count();
      for (let i = 0; i < inputs; i++) {
        const id = await page.locator("form input").nth(i).getAttribute("id");
        assert.ok(id && (await page.locator(`label[for="${id}"]`).count()) === 1, `input #${id} has no label`);
      }
    },
  },
  {
    name: "successful_payment",
    async run(page) {
      await page.getByTestId("pay").click();
      await complete(page).waitFor({ timeout: 4000 });
      assert.equal(await page.getByTestId("checkout-form").getAttribute("data-state"), "complete");
    },
  },
  {
    name: "error_handling",
    async run(page, h) {
      await h.setFault("payment_failures", 1);
      await page.getByTestId("pay").click();
      const alert = page.getByRole("alert");
      await alert.waitFor({ timeout: 4000 });
      assert.match((await alert.textContent()) ?? "", /declined/);
      assert.ok(await page.getByTestId("pay").isEnabled(), "user must be able to retry after a decline");
    },
  },
  {
    name: "duplicate_submission_prevention",
    async run(page) {
      const req = payRequests(page);
      await page.getByTestId("pay").dblclick();
      await page.waitForTimeout(900);
      assert.ok(req.bodies.length <= 1, `a double click sent ${req.bodies.length} payment requests; the page must guard against duplicate submission`);
    },
  },
  {
    name: "accessibility_basics",
    async run(page) {
      assert.ok(await page.locator("html").getAttribute("lang"), "html lang is required");
      assert.equal(await page.getByRole("button", { name: /Pay/ }).count(), 1, "pay button needs an accessible name");
      assert.equal(await page.locator('[role="status"]').count(), 1, "a status live region is required");
      await page.getByTestId("pay").focus();
      const outline = await page.getByTestId("pay").evaluate((el) => getComputedStyle(el).outlineStyle);
      assert.notEqual(outline, "none", "focused controls need a visible focus indicator");
      assert.equal(await page.locator("h1").count(), 1, "exactly one h1");
    },
  },
  {
    name: "loading_state",
    async run(page) {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => { release = r; });
      await page.route("**/api/pay", async (route) => { await gate; await route.continue(); });
      await page.getByTestId("pay").click();
      const pay = page.getByTestId("pay");
      assert.equal(await pay.getAttribute("aria-busy"), "true", "button must be marked busy while pending");
      assert.match((await pay.textContent()) ?? "", /Processing/);
      release();
      await complete(page).waitFor({ timeout: 4000 });
    },
  },
  {
    name: "api_timeout_behaviour",
    async run(page) {
      await page.route("**/api/pay", async (route) => { await new Promise((r) => setTimeout(r, 3500)); await route.abort().catch(() => {}); });
      await page.getByTestId("pay").click();
      const alert = page.getByRole("alert");
      await alert.waitFor({ timeout: 4500 });
      assert.match((await alert.textContent()) ?? "", /longer than expected|could not reach/i);
      assert.ok(await page.getByTestId("pay").isEnabled(), "user must be able to retry after a timeout");
    },
  },
  {
    name: "failure_recovery",
    async run(page) {
      const req = payRequests(page);
      let failed = false;
      await page.route("**/api/pay", async (route) => {
        if (!failed) { failed = true; return route.fulfill({ status: 503, contentType: "application/json", body: '{"status":"error"}' }); }
        return route.continue();
      });
      await page.getByTestId("pay").click();
      await page.getByRole("alert").waitFor({ timeout: 4000 });
      await page.getByTestId("pay").click();
      await complete(page).waitFor({ timeout: 4000 });
      const keys = req.bodies.map((b) => (JSON.parse(b) as { idempotencyKey?: string }).idempotencyKey);
      assert.equal(keys.length, 2);
      assert.equal(keys[0], keys[1], "a retry must reuse the idempotency key so the server cannot double-charge");
    },
  },
  {
    name: "latency_budget",
    async run(page) {
      const t0 = Date.now();
      await page.getByTestId("pay").click();
      await complete(page).waitFor({ timeout: 4000 });
      const ms = Date.now() - t0;
      assert.ok(ms < 1000, `checkout took ${ms}ms; budget is 1000ms`);
    },
  },
];
