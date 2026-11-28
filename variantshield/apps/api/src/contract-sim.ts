import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Ctx } from "./context.ts";
import { HttpError } from "./http.ts";
import { checkContract, ingestObservations, invalidateReports, issueIdentity, registerContract } from "./contracts.ts";
import type { FeatureValue } from "../../../packages/contracts/src/index.ts";

/**
 * SIMULATION MODE for contracts. Deterministic synthetic subjects and surfaces, stored under the contract id
 * "sim-checkout-journey" with source = "simulation". The variant is a deterministic split of the subject reference,
 * NOT a Flagsmith assignment, and Flagsmith is never contacted. A scenario run resets this one simulated contract.
 */
export const SIM_CONTRACT_ID = "sim-checkout-journey";
export const EXAMPLE_MANIFEST = resolve(import.meta.dirname, "../../../examples/checkout-journey.contract.yaml");

export interface ContractScenario { id: string; title: string; description: string; expectedCode: string }
export const CONTRACT_SCENARIOS: ContractScenario[] = [
  { id: "valid", title: "Valid contract", description: "All four surfaces receive the expected variant and configuration for every subject.", expectedCode: "CONTRACT_VALID" },
  { id: "invalid-combination", title: "Invalid cross-surface combination", description: "Web shows upi_first, the payment API still routes through legacy and the risk engine keeps the standard retry policy.", expectedCode: "COMBINATION_VIOLATION" },
  { id: "assignment-mismatch", title: "Assignment mismatch", description: "For some subjects the mobile checkout reports a different variant from the other surfaces.", expectedCode: "ASSIGNMENT_MISMATCH" },
  { id: "environment-mismatch", title: "Environment mismatch", description: "The payment API evaluates the assignment against the staging environment.", expectedCode: "ENVIRONMENT_MISMATCH" },
  { id: "unlinked-identity", title: "Unlinked identity", description: "The web checkout sends tampered identity tokens, so its observations cannot be correlated.", expectedCode: "IDENTITY_UNLINKED" },
];

const FEATURES: Record<string, Record<string, FeatureValue>> = {
  control: { checkout_ui: "classic", payment_route: "legacy", retry_policy: "standard" },
  upi_first: { checkout_ui: "upi_first", payment_route: "upi_intent_v2", retry_policy: "bounded" },
};
const SURFACE_FEATURES: Record<string, string[]> = { "web-checkout": ["checkout_ui"], "mobile-checkout": ["checkout_ui"], "payment-api": ["payment_route"], "risk-engine": ["retry_policy"] };
const SUBJECTS = 24;

export async function runContractScenario(ctx: Ctx, scenarioId: string) {
  const scenario = CONTRACT_SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) throw new HttpError(404, "scenario_not_found", `Unknown scenario "${scenarioId}". Available: ${CONTRACT_SCENARIOS.map((s) => s.id).join(", ")}`);
  const manifest = parseYaml(readFileSync(EXAMPLE_MANIFEST, "utf8")) as { contract: { id: string; description: string } };
  manifest.contract.id = SIM_CONTRACT_ID;
  manifest.contract.description = `[SIMULATION] ${scenario.title}: ${scenario.description}`;

  ctx.db.tx(() => { for (const t of ["contract_observations", "contract_findings", "contract_drift", "assignment_config_snapshots", "contracts"]) ctx.db.run(`DELETE FROM ${t} WHERE contract_id = ?`, SIM_CONTRACT_ID); });
  invalidateReports(ctx, SIM_CONTRACT_ID);
  registerContract(ctx, manifest, "simulation", { simulation: true });

  const now = ctx.now();
  const fingerprint = "5151515151515151";
  const batch: Record<string, unknown>[] = [];
  for (let i = 0; i < SUBJECTS; i++) {
    const id = issueIdentity(ctx, { subject: `sim-customer-${i}`, ttlSeconds: 3600 });
    const variant = parseInt(id.subjectRef.slice(4, 8), 36) % 2 === 0 ? "control" : "upi_first";
    for (const [surfaceId, feats] of Object.entries(SURFACE_FEATURES)) {
      let v = variant;
      let features: Record<string, FeatureValue> = Object.fromEntries(feats.map((f) => [f, FEATURES[variant]![f]!]));
      let environment = "production";
      let token = id.token;
      if (scenario.id === "invalid-combination" && variant === "upi_first") {
        if (surfaceId === "payment-api") features = { payment_route: "legacy" };
        if (surfaceId === "risk-engine") features = { retry_policy: "standard" };
      }
      if (scenario.id === "assignment-mismatch" && surfaceId === "mobile-checkout" && i % 4 === 0) { v = variant === "control" ? "upi_first" : "control"; features = { checkout_ui: FEATURES[v]!.checkout_ui! }; }
      if (scenario.id === "environment-mismatch" && surfaceId === "payment-api" && i % 3 === 0) environment = "staging";
      if (scenario.id === "unlinked-identity" && surfaceId === "web-checkout" && i % 4 === 0) token = `${token.slice(0, -4)}AAAA`;
      batch.push({ observationId: `sim-${scenario.id}-${i}-${surfaceId}`, contractId: SIM_CONTRACT_ID, contractVersion: 1, experimentKey: "checkout_journey", environment, envFingerprint: fingerprint, assignmentFlag: "checkout_journey_variant", assignedVariant: v, surfaceId, identityToken: token, observedAt: now - 30_000 - i * 500, features });
    }
  }
  const ingested = ingestObservations(ctx, batch, { simulation: true });
  const checked = await checkContract(ctx, SIM_CONTRACT_ID);
  const observed = checked.report.status === "CONTRACT_VALID" ? "CONTRACT_VALID" : checked.report.primaryCode;
  return { scenario, label: "SIMULATION: synthetic subjects; variants are a deterministic split, not a Flagsmith assignment", ingested: { accepted: ingested.accepted, unlinked: ingested.unlinked, rejected: ingested.rejected }, expectedCode: scenario.expectedCode, observedCode: observed, matched: observed === scenario.expectedCode, report: checked.report };
}
