import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { createDemoApp } from "../../checkout-demo/src/server.ts";
import { noopTelemetry } from "../../checkout-demo/src/instrument.ts";
import { FAULT_TYPES, type FaultType } from "../../checkout-demo/src/faults.ts";
import { SUITE, type Harness } from "./suite.ts";

export interface BenchResult { variant: string; name: string; status: "passed" | "failed"; durationMs: number; error?: string; screenshot?: string }
export const VARIANTS = ["control", "upi_first", "one_tap"] as const;
/** The treatment a --fault is injected into, to show how a visually fine variant can be unsafe. */
export const FAULT_TARGET = "upi_first";

export async function runBench(opts: { out: string; fault: FaultType; target?: string; log?: (s: string) => void }): Promise<BenchResult[]> {
  const log = opts.log ?? ((s) => console.log(s));
  const shots = join(opts.out, "screenshots");
  mkdirSync(shots, { recursive: true });
  const controlKey = "bench-control-key";
  let baseUrl = opts.target ?? "";
  let closeServer = async (): Promise<void> => {};
  const demo = opts.target ? null : createDemoApp({ flagsmith: null, telemetry: noopTelemetry, cfg: { featureKey: "checkout_flow", latencyScale: 0.5, allowOverride: true, allowUidHeader: false, controlKey, clientTimeoutMs: 1500 } });
  if (demo) {
    await new Promise<void>((r) => demo.server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(demo.server.address() as { port: number }).port}`;
    closeServer = () => new Promise((r) => demo.server.close(() => r()));
  }
  const key = demo ? controlKey : (process.env.DEMO_CONTROL_KEY ?? "");
  const faultCall = async (variant: string, type: string | null, rate = 1): Promise<void> => {
    if (demo) {
      if (type) demo.faults.set({ variant, type: type as FaultType, rate });
      else demo.faults.clear();
      return;
    }
    await fetch(`${baseUrl}/__fault`, type ? { method: "POST", headers: { "x-demo-key": key }, body: JSON.stringify({ variant, type, rate }) } : { method: "DELETE", headers: { "x-demo-key": key } });
  };

  const browser = await chromium.launch();
  const results: BenchResult[] = [];
  try {
    for (const variant of VARIANTS) {
      for (const test of SUITE) {
        const harness: Harness = { browser, baseUrl, variant, setFault: (type, rate) => faultCall(variant, type, rate) };
        // Baseline fault for the whole run, then the test may layer its own.
        if (opts.fault !== "none" && variant === FAULT_TARGET) await faultCall(variant, opts.fault, 1); else await faultCall(variant, null);
        const ctx = await browser.newContext({ viewport: { width: 420, height: 760 }, deviceScaleFactor: 2 });
        const page = await ctx.newPage();
        const started = Date.now();
        let status: BenchResult["status"] = "passed";
        let error: string | undefined;
        try {
          await page.goto(`${baseUrl}/?variant=${variant}`, { waitUntil: "load" });
          await test.run(page, harness);
        } catch (e) {
          status = "failed";
          error = (e instanceof Error ? e.message : String(e)).split("\n")[0]?.slice(0, 400);
        }
        const file = `${variant}-${test.name}.png`;
        await page.screenshot({ path: join(shots, file) }).catch(() => {});
        await ctx.close();
        results.push({ variant, name: test.name, status, durationMs: Date.now() - started, ...(error ? { error } : {}), screenshot: file });
        log(`${status === "passed" ? "PASS" : "FAIL"}  ${variant.padEnd(10)} ${test.name}${error ? `  ${error}` : ""}`);
      }
    }
  } finally {
    await browser.close();
    await faultCall(FAULT_TARGET, null);
    await closeServer();
  }
  writeFileSync(join(opts.out, "results.json"), JSON.stringify({ fault: opts.fault, finishedAt: new Date().toISOString(), results }, null, 2));
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { out: { type: "string", default: "bench-output" }, fault: { type: "string", default: "none" }, target: { type: "string" } } });
  const fault = values.fault as FaultType;
  if (!FAULT_TYPES.includes(fault)) { console.error(`--fault must be one of ${FAULT_TYPES.join(", ")}`); process.exit(2); }
  const results = await runBench({ out: resolve(values.out!), fault, ...(values.target ? { target: values.target } : {}) });
  const failed = results.filter((r) => r.status === "failed").length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
