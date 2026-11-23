import { loadConfig } from "../apps/api/src/config.ts";
import { Db } from "../apps/api/src/db.ts";
import { runScenario, SCENARIOS } from "../apps/api/src/simulation.ts";
import { verdictFor } from "../apps/api/src/reliability.ts";

/** Runs both deterministic scenarios in an in-memory database and prints the dual verdicts. No network, no Flagsmith. */
const cfg = loadConfig({ VARIANTSHIELD_ADMIN_TOKEN: "x".repeat(24), VARIANTSHIELD_INGEST_KEY: "y".repeat(24), VARIANTSHIELD_DB_PATH: ":memory:" });
const ctx = { cfg, db: new Db(":memory:"), now: () => Date.now(), flagsmith: null };

console.log("SIMULATION MODE: synthetic, deterministic data. Nothing here is a real observation and Flagsmith is not contacted.\n");
for (const s of SCENARIOS) {
  const { plan, events } = runScenario(ctx, s.id);
  const r = await verdictFor(ctx, plan, "simulation");
  console.log(`== ${s.title}: ${s.description}`);
  console.log(`   ${events} simulated events`);
  console.log(`   Verdict A (Flagsmith result fixture): ${r.verdict.experimentVerdict.state}${r.verdict.experimentVerdict.winner ? ` winner=${r.verdict.experimentVerdict.winner}` : ""}`);
  console.log(`   Verdict B (reliability):              ${r.verdict.reliabilityVerdict.status}`);
  console.log(`   Outcome: ${r.verdict.outcome}. ${r.verdict.headline}`);
  console.log(`   Recommended action: ${r.verdict.recommendedAction} (requires human approval)`);
  for (const line of r.verdict.evidence.filter((l) => /BREACH|WARNING/.test(l))) console.log(`     - ${line}`);
  console.log();
}
