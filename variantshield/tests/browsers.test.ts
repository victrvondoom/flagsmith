import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { chromium, firefox, webkit, type Browser, type BrowserType } from "playwright";
import { loadConfig } from "../apps/api/src/config.ts";
import { Db } from "../apps/api/src/db.ts";
import { createApp, type App } from "../apps/api/src/app.ts";
import { FlagsmithClient } from "../packages/flagsmith-adapter/src/index.ts";
import { SAMPLE_EXPERIMENT, startFakeFlagsmith, type FakeFlagsmith } from "../packages/flagsmith-adapter/src/testing/fake-flagsmith.ts";
import { createDemoApp, type DemoApp } from "../apps/checkout-demo/src/server.ts";

/**
 * Cross-browser smoke test. The main UI suites run in Chromium. Set PW_BROWSER=firefox or webkit (CI does) to check that the
 * dashboard renders and that the demo's identity cookie survives over http://127.0.0.1 in that engine. WebKit refuses Secure cookies over plain
 * HTTP (CI confirmed it), which is why the demo omits Secure for loopback clients only.
 */
process.env.VARIANTSHIELD_LOG = "off";
const NAME = (process.env.PW_BROWSER ?? "chromium") as "chromium" | "firefox" | "webkit";
const TYPES: Record<string, BrowserType> = { chromium, firefox, webkit };
const ADMIN = "ui-admin-token-0123456789";
let app: App, base: string, browser: Browser, fake: FakeFlagsmith, demo: DemoApp, demoBase: string;

beforeEach(async () => {
  const cfg = loadConfig({ VARIANTSHIELD_ADMIN_TOKEN: ADMIN, VARIANTSHIELD_INGEST_KEY: "ui-ingest-key-0123456789", VARIANTSHIELD_IDENTITY_ISSUER_KEY: "ui-issuer-key-0123456789", VARIANTSHIELD_IDENTITY_SECRET: "ui-identity-secret-0123456789abcdef", VARIANTSHIELD_DB_PATH: ":memory:", PORT: "0" });
  app = createApp({ cfg, db: new Db(":memory:"), now: () => Date.now(), flagsmith: null });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  fake = await startFakeFlagsmith({ experiments: [SAMPLE_EXPERIMENT] });
  demo = createDemoApp({ flagsmith: new FlagsmithClient({ baseUrl: fake.url, environmentKey: fake.environmentKey }), telemetry: { emit: () => {}, flush: async () => {} }, cfg: { featureKey: "checkout_flow", latencyScale: 0.001, allowOverride: false, allowUidHeader: false, controlKey: "demo-control-key-1234" } });
  await new Promise<void>((r) => demo.server.listen(0, "127.0.0.1", r));
  demoBase = `http://127.0.0.1:${(demo.server.address() as AddressInfo).port}`;
  browser = await TYPES[NAME]!.launch();
});
afterEach(async () => { await browser.close(); await new Promise<void>((r) => demo.server.close(() => r())); await new Promise<void>((r) => app.server.close(() => r())); app.ctx.db.close(); await fake.close(); });

describe(`cross-browser smoke (${NAME})`, () => {
  it("dashboard__signs_in_renders_the_ledger_and_fits_a_phone_screen", { timeout: 90_000 }, async () => {
    const sim = await (await fetch(`${base}/api/simulate/dangerous-winner`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } })).json() as { plan: { id: number } };
    const problems: string[] = [];
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" && !/status of (400|401|403|409)/.test(m.text())) problems.push(`console: ${m.text()}`); });
    await page.goto(base);
    await page.getByLabel("Admin token").fill(ADMIN);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("navigation").getByRole("link", { name: "Decision Ledger" }).click();
    await page.getByRole("heading", { name: "Decision Ledger" }).waitFor();
    await page.locator("#integrity").getByText("LEDGER VERIFIED").waitFor();
    await page.getByRole("button", { name: "Should we ship this?" }).click();
    await page.locator("#assistant .answer .draft strong", { hasText: "Draft: PAUSE" }).waitFor();
    const overflow = await page.evaluate(() => {
      const w = window.innerWidth;
      return { scrollWidth: document.documentElement.scrollWidth, innerWidth: w, offenders: [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > w + 1).slice(0, 12).map((e) => `${e.tagName.toLowerCase()}#${e.id}.${(e as HTMLElement).className} right=${Math.round(e.getBoundingClientRect().right)} width=${Math.round(e.getBoundingClientRect().width)}`) };
    });
    assert.ok(overflow.scrollWidth <= overflow.innerWidth + 1, `horizontal page scroll at 390px in ${NAME}: ${JSON.stringify(overflow)}`);
    assert.deepEqual(problems, [], "no console errors or CSP violations");
    assert.ok(sim.plan.id > 0);
  });

  it("demo_cookie__over_loopback_http__keeps_the_same_identity_across_requests", async () => {
    const page = await (await browser.newContext()).newPage();
    const first = await page.goto(demoBase);
    const setCookie = (await first!.allHeaders())["set-cookie"] ?? "";
    assert.match(setCookie, /vs_uid=/);
    assert.match(setCookie, /HttpOnly/);
    assert.doesNotMatch(setCookie, /Secure/, "loopback over plain HTTP deliberately omits Secure: WebKit drops Secure cookies there");
    // A second request from the same browser must carry the cookie back, so the identity (and its variant) is stable.
    const second = await page.reload();
    assert.equal((await second!.allHeaders())["set-cookie"], undefined, `${NAME} did not send the cookie back over http://127.0.0.1, so the demo issued a new identity`);
    const variant = (await page.content()).match(/data-variant="(\w+)"/)?.[1];
    await page.reload();
    assert.equal((await page.content()).match(/data-variant="(\w+)"/)?.[1], variant, "the variant must stay the same for one browser");
  });
});
