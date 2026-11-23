import { parseArgs } from "node:util";
import { runTraffic } from "./traffic.ts";
import { mulberry32 } from "../packages/guardrail-engine/src/fixtures.ts";

/**
 * Drives the end-to-end demo against a RUNNING stack: real Flagsmith, VariantShield API, checkout demo.
 * It never pauses an experiment on its own: pass --approve "PAUSE <id>" to act as the human who confirms.
 */
const { values } = parseArgs({ options: {
  api: { type: "string", default: "http://127.0.0.1:8787" }, demo: { type: "string", default: "http://127.0.0.1:8791" },
  users: { type: "string", default: "900" }, window: { type: "string", default: "60000" }, approve: { type: "string" },
} });
const env = process.env;
for (const k of ["VARIANTSHIELD_ADMIN_TOKEN", "DEMO_CONTROL_KEY"]) if (!env[k]) { console.error(`Set ${k}`); process.exit(2); }
const api = async (method: string, path: string, body?: unknown): Promise<any> => {
  const r = await fetch(values.api + path, { method, headers: { authorization: `Bearer ${env.VARIANTSHIELD_ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const demoFault = (method: string, body?: unknown): Promise<Response> => fetch(`${values.demo}/__fault`, { method, headers: { "x-demo-key": env.DEMO_CONTROL_KEY! }, body: body === undefined ? undefined : JSON.stringify(body) });
const say = (s: string): void => console.log(`\n== ${s}`);
const windowMs = Number(values.window);
const users = Number(values.users);

say("1-3. Connect to Flagsmith and import the experiment");
const imported = await api("POST", "/api/plans/import-flagsmith", {});
const plans = (await api("GET", "/api/plans")).plans.filter((p: any) => !p.isSimulation && p.flagsmithExperimentId !== null);
const plan = plans[0];
if (!plan) throw new Error("No Flagsmith experiment found. See docs/guides/FLAGSMITH_SETUP.md");
console.log(`imported ${imported.imported}; using plan #${plan.id} "${plan.title}" -> Flagsmith experiment ${plan.flagsmithExperimentId}`);
// Demo-scale sample floors and a short window so the demo finishes in minutes. Production defaults are in the engine.
await api("PATCH", `/api/plans/${plan.id}`, { key: String(plan.flagsmithExperimentId), guardrailOverrides: { windowMs, rules: {
  payment_failure_rate: { minDenominator: 60 }, duplicate_submission_rate: { minDenominator: 60 }, http_5xx_rate: { minDenominator: 60 }, checkout_p95_latency_ms: { minSamples: 60 } } } });
const flagsmithStatus = (await api("GET", `/api/control/${plan.id}/status`)).status;
console.log(`Flagsmith reports the experiment is "${flagsmithStatus}"`);

const show = async (label: string): Promise<any> => {
  const v = (await api("GET", `/api/plans/${plan.id}/verdict`)).verdict;
  console.log(`${label}: ${v.outcome} | experiment=${v.experimentVerdict.state}${v.experimentVerdict.winner ? `(${v.experimentVerdict.winner})` : ""} reliability=${v.reliabilityVerdict.status} | action=${v.recommendedAction}`);
  console.log(`   ${v.headline}`);
  return v;
};

say("4-8. Phase 1: healthy traffic. Flagsmith assigns variants; exposures, conversions and telemetry flow");
await demoFault("DELETE");
console.log(JSON.stringify((await runTraffic({ baseUrl: values.demo!, users, uidPrefix: `live-a-${Date.now()}`, random: mulberry32(11), concurrency: 8 })).variant));
await new Promise((r) => setTimeout(r, 1500));
await show("healthy phase");

say("9. Inject a controlled fault into upi_first (payment failures) and let the window roll");
await demoFault("POST", { variant: "upi_first", type: "payment_failures", rate: 0.15 });
await new Promise((r) => setTimeout(r, windowMs + 2000));
console.log(JSON.stringify((await runTraffic({ baseUrl: values.demo!, users, uidPrefix: `live-b-${Date.now()}`, random: mulberry32(12), concurrency: 8 })).variant));
await new Promise((r) => setTimeout(r, 1500));
say("10-11. upi_first is still Flagsmith's conversion winner, but fails reliability guardrails");
const v = await show("faulty phase");
for (const line of v.evidence.filter((l: string) => /BREACH|WARNING/.test(l))) console.log(`   - ${line}`);
const ev = await api("POST", `/api/plans/${plan.id}/evidence`, {});
console.log(`evidence snapshot #${ev.id} stored`);
await demoFault("DELETE");

say("12-14. Human-approved pause through Flagsmith");
const id = plan.flagsmithExperimentId;
const dry = await api("POST", "/api/control", { planId: plan.id, action: "pause", dryRun: true });
console.log(`dry run: would call "${dry.wouldCall}" (Flagsmith: ${dry.before} -> ${dry.after})`);
if (!values.approve) {
  console.log(`\nNot pausing: a human must confirm. Re-run with --approve "PAUSE ${id}" or use the dashboard Experiment Control screen.`);
} else {
  const done = await api("POST", "/api/control", { planId: plan.id, action: "pause", dryRun: false, confirmation: values.approve, reason: "Reliability guardrail breach on the conversion winner (live demo)", evidenceId: ev.id });
  console.log(`executed: Flagsmith ${done.before} -> ${done.after}`);
  const after = (await api("GET", `/api/control/${plan.id}/status`)).status;
  console.log(`independent re-read of Flagsmith: "${after}"`);
}
