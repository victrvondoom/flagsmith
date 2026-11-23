import { parseArgs } from "node:util";
import { FlagsmithClient } from "../packages/flagsmith-adapter/src/index.ts";
import { mulberry32 } from "../packages/guardrail-engine/src/fixtures.ts";

/**
 * SYNTHETIC SEED DATA. Sends exposures and conversions for fake identities straight to Flagsmith's events endpoint so a
 * demo experiment accumulates enough data for Flagsmith to name a winner quickly. These identities were NOT served by
 * Flagsmith; never run this against an experiment whose results you care about.
 */
const { values } = parseArgs({ options: { feature: { type: "string", default: "checkout_flow" }, identities: { type: "string", default: "6000" }, seed: { type: "string", default: "42" } } });
const env = process.env;
if (!env.FLAGSMITH_URL || !env.FLAGSMITH_ENVIRONMENT_KEY) { console.error("Set FLAGSMITH_URL and FLAGSMITH_ENVIRONMENT_KEY."); process.exit(2); }
const fs = new FlagsmithClient({ baseUrl: env.FLAGSMITH_URL, environmentKey: env.FLAGSMITH_ENVIRONMENT_KEY });
const rand = mulberry32(Number(values.seed));
const RATES: Record<string, number> = { control: 0.3, upi_first: 0.36, one_tap: 0.31 };
const variants = Object.keys(RATES);
const total = Number(values.identities);
const now = Date.now();
let batch: Parameters<FlagsmithClient["sendEvents"]>[0] = [];
let sent = 0;
for (let i = 0; i < total; i++) {
  const variant = variants[i % variants.length]!;
  const id = `synthetic-${values.seed}-${i}`;
  batch.push({ event: "$flag_exposure", featureName: values.feature, identifier: id, timestampMs: now - 60_000, value: variant });
  if (rand() < (RATES[variant] ?? 0)) batch.push({ event: "checkout_completed", identifier: id, timestampMs: now - 30_000, value: 1 });
  if (batch.length >= 450) { await fs.sendEvents(batch); sent += batch.length; batch = []; }
}
if (batch.length) { await fs.sendEvents(batch); sent += batch.length; }
console.log(`SYNTHETIC: sent ${sent} events for ${total} fake identities to ${fs.describe().baseUrl}`);
