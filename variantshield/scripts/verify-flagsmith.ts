import { parseArgs } from "node:util";
import { FlagsmithClient, FlagsmithError } from "../packages/flagsmith-adapter/src/index.ts";

/**
 * Verifies VariantShield's adapter against a REAL Flagsmith instance. Read-only by default.
 *   --lifecycle   also starts, pauses and resumes the experiment (changes its state in Flagsmith!)
 *   --events N    sends exposures and conversions for N synthetic identities
 */
const { values } = parseArgs({ options: { feature: { type: "string", default: "checkout_flow" }, experiment: { type: "string" }, lifecycle: { type: "boolean", default: false }, events: { type: "string", default: "0" } } });
const env = process.env;
if (!env.FLAGSMITH_URL || !env.FLAGSMITH_ENVIRONMENT_KEY) { console.error("Set FLAGSMITH_URL, FLAGSMITH_ENVIRONMENT_KEY and FLAGSMITH_ADMIN_API_KEY (or FLAGSMITH_ADMIN_TOKEN)."); process.exit(2); }
const admin = env.FLAGSMITH_ADMIN_API_KEY ? { scheme: "Api-Key" as const, value: env.FLAGSMITH_ADMIN_API_KEY } : env.FLAGSMITH_ADMIN_TOKEN ? { scheme: "Token" as const, value: env.FLAGSMITH_ADMIN_TOKEN } : undefined;
const fs = new FlagsmithClient({ baseUrl: env.FLAGSMITH_URL, environmentKey: env.FLAGSMITH_ENVIRONMENT_KEY, ...(admin ? { admin } : {}) });

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`); if (!ok) failures++; };
const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
  try { const r = await fn(); check(name, true); return r; } catch (e) { check(name, false, e instanceof FlagsmithError ? `${e.kind}: ${e.message} ${JSON.stringify(e.detail)}` : String(e)); return null; }
};

console.log(`Target: ${JSON.stringify(fs.describe())}`);
const list = await step("list experiments (Management API)", () => fs.listExperiments());
const exp = list?.find((e) => (values.experiment ? String(e.id) === values.experiment : e.featureName === values.feature));
check("find experiment for feature", Boolean(exp), exp ? `id=${exp.id} status=${exp.status}` : `no experiment for ${values.feature}`);
if (!exp) process.exit(1);
console.log(`  experiment: ${JSON.stringify({ id: exp.id, name: exp.name, status: exp.status, feature: exp.featureName, variantOptions: exp.variantOptions })}`);

if (values.lifecycle) {
  if (exp.status === "created") { const r = await step("start experiment", () => fs.transition(exp.id, "start")); check("Flagsmith reports running after start", r?.status === "running"); }
}

const counts: Record<string, number> = {};
const assignments: { id: string; variant: string }[] = [];
const n = Math.max(Number(values.events), 60);
for (let i = 0; i < n; i++) {
  const id = `verify-${Date.now()}-${i}`;
  const a = await fs.getIdentityAssignment(id, values.feature);
  const key = a.variantKey ?? `(none:${a.reason})`;
  counts[key] = (counts[key] ?? 0) + 1;
  if (a.variantKey) assignments.push({ id, variant: a.variantKey });
}
console.log(`  identity assignments over ${n} identities: ${JSON.stringify(counts)}`);
check("Flagsmith serves at least 2 distinct variants", Object.keys(counts).filter((k) => !k.startsWith("(none")).length >= 2);

if (Number(values.events) > 0) {
  const ts = Date.now();
  await step("send $flag_exposure events", async () => { await fs.sendEvents(assignments.map((a) => ({ event: "$flag_exposure", featureName: values.feature, identifier: a.id, timestampMs: ts, value: a.variant }))); });
  const converting = assignments.filter((_, i) => i % 3 === 0);
  await step("send checkout_completed conversion events", async () => { await fs.sendEvents(converting.map((a) => ({ event: "checkout_completed", identifier: a.id, timestampMs: ts + 1000, value: 1 }))); });
}

const live = await fs.getExperiment(exp.id);
if (live.status !== "created") {
  for (const what of ["exposures", "results"] as const) {
    try { await fs.refresh(exp.id, what); check(`refresh ${what}`, true); } catch (e) {
      // Flagsmith allows one refresh per 5 minutes; being throttled is expected behaviour, not a failure.
      if (e instanceof FlagsmithError && e.kind === "rate_limited") console.log(`SKIP  refresh ${what}  throttled by Flagsmith: ${JSON.stringify(e.detail)}`);
      else check(`refresh ${what}`, false, String(e));
    }
  }
  const exposures = await step("read exposures", () => fs.getExposures(exp.id));
  console.log(`  exposures: ${JSON.stringify(exposures)}`);
  const results = await step("read results and parse real payload", () => fs.getResults(exp.id));
  console.log(`  results summary: ${JSON.stringify(results?.summary)}`);
} else {
  console.log("  (experiment not started: results and exposures need --lifecycle or a started experiment)");
}

if (values.lifecycle) {
  const p = await step("pause experiment", () => fs.transition(exp.id, "pause"));
  check("Flagsmith reports paused after pause", p?.status === "paused", `status=${p?.status}`);
  const again = await fs.getExperiment(exp.id);
  check("a fresh read confirms paused", again.status === "paused");
  const r = await step("resume experiment", () => fs.transition(exp.id, "start"));
  check("Flagsmith reports running after resume", r?.status === "running", `status=${r?.status}`);
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll live checks passed");
process.exit(failures ? 1 : 0);
