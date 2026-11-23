import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseContract, type Contract, type ContractObservation, type FeatureValue } from "./index.ts";

export const EXAMPLE_PATH = resolve(import.meta.dirname, "../../../examples/checkout-journey.contract.yaml");
export function exampleContract(over: (raw: any) => void = () => {}): Contract {
  const raw = parseYamlSync(readFileSync(EXAMPLE_PATH, "utf8"));
  over(raw);
  const r = parseContract(raw);
  if (!r.ok) throw new Error(`example contract invalid: ${JSON.stringify(r.issues)}`);
  return r.contract;
}
import { parse as parseYamlSync } from "yaml";

export const FEATURES: Record<string, Record<string, FeatureValue>> = {
  control: { checkout_ui: "classic", payment_route: "legacy", retry_policy: "standard" },
  upi_first: { checkout_ui: "upi_first", payment_route: "upi_intent_v2", retry_policy: "bounded" },
};
export const SURFACE_FEATURES: Record<string, string[]> = { "web-checkout": ["checkout_ui"], "mobile-checkout": ["checkout_ui"], "payment-api": ["payment_route"], "risk-engine": ["retry_policy"] };

export const NOW = 1_800_000_000_000;

/** Builds one observation per surface for a subject, the way a correct deployment would. */
export function observe(subject: string, variant: string, over: Partial<Record<string, Partial<ContractObservation>>> = {}, at = NOW - 30_000): ContractObservation[] {
  return Object.entries(SURFACE_FEATURES).map(([surfaceId, feats]) => ({
    observationId: `${subject}-${surfaceId}-${at}`, contractId: "checkout-journey", contractVersion: 1, experimentKey: "checkout_journey", environment: "production",
    envFingerprint: "aaaaaaaaaaaaaaaa", assignmentFlag: "checkout_journey_variant", assignedVariant: variant, surfaceId, subjectRef: subject, identityStatus: "verified" as const,
    identityReason: null, observedAtMs: at, features: Object.fromEntries(feats.map((f) => [f, FEATURES[variant]![f]!])), source: "simulation" as const, ...(over[surfaceId] ?? {}),
  }));
}
export const SUBJECT = "sub_" + "a".repeat(32);
