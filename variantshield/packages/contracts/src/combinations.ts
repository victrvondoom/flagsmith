import { fmt, type CombinationCode, type CombinationFinding, type CombinationResult, type Contract, type FeatureValue } from "./types.ts";

const same = (a: FeatureValue, b: FeatureValue): boolean => a === b;
const SEVERITY: Record<CombinationCode, number> = { CONTRACT_INVALID: 4, COMBINATION_VIOLATION: 3, MISSING_REQUIRED_FEATURE: 2, UNKNOWN_FEATURE_VALUE: 1, COMBINATION_VALID: 0 };

export function allowedValues(contract: Contract, feature: string): FeatureValue[] {
  const out: FeatureValue[] = [];
  for (const m of Object.values(contract.variants)) if (feature in m && !out.some((x) => same(x, m[feature]!))) out.push(m[feature]!);
  return out;
}
export const featureUniverse = (contract: Contract): string[] => [...new Set(Object.values(contract.variants).flatMap((m) => Object.keys(m)))];

export interface CombinationInput {
  /** The variant Flagsmith assigned. null = no assignment, which is reported by the caller, not here. */
  variant: string | null;
  /** Feature values actually resolved by the application. */
  features: Record<string, FeatureValue>;
  /** Features that must be present. Default: every feature the variant defines. Pass a surface's own list to validate one surface. */
  requiredFeatures?: readonly string[];
  /** Evaluate cross-feature constraints (only meaningful on a merged view across surfaces). */
  checkConstraints?: boolean;
}

/**
 * Deterministic application-level combination check. It does not duplicate Flagsmith's feature dependencies:
 * it validates resolved values reported by separate application surfaces against the contract's variant table and constraints.
 */
export function validateCombination(contract: Contract, input: CombinationInput): CombinationResult {
  const findings: CombinationFinding[] = [];
  const add = (f: CombinationFinding): void => void findings.push(f);
  const variantDef = input.variant === null ? undefined : contract.variants[input.variant];
  const universe = featureUniverse(contract);

  if (input.variant !== null && !variantDef) {
    add({ code: "UNKNOWN_FEATURE_VALUE", kind: "unknown_variant", feature: null, constraintId: null, expected: Object.keys(contract.variants).join(" | "), actual: input.variant, message: `Variant "${input.variant}" is not defined by contract ${contract.id} v${contract.version}` });
  }

  for (const [feature, value] of Object.entries(input.features)) {
    if (!universe.includes(feature)) { add({ code: "UNKNOWN_FEATURE_VALUE", kind: "unknown_feature", feature, constraintId: null, expected: universe.join(" | "), actual: feature, message: `Feature "${feature}" is not part of the contract` }); continue; }
    const ok = allowedValues(contract, feature);
    if (!ok.some((x) => same(x, value))) { add({ code: "UNKNOWN_FEATURE_VALUE", kind: "unknown_value", feature, constraintId: null, expected: fmt(ok), actual: String(value), message: `${feature}=${value} is not a value any variant defines (allowed: ${fmt(ok)})` }); continue; }
    if (variantDef && feature in variantDef && !same(variantDef[feature]!, value)) {
      add({ code: "COMBINATION_VIOLATION", kind: "variant_value", feature, constraintId: null, expected: String(variantDef[feature]), actual: String(value), message: `${feature} is ${value} but variant "${input.variant}" requires ${variantDef[feature]}` });
    }
  }

  const required = input.requiredFeatures ?? (variantDef ? Object.keys(variantDef) : []);
  for (const feature of required) if (!(feature in input.features)) {
    add({ code: "MISSING_REQUIRED_FEATURE", kind: "missing_feature", feature, constraintId: null, expected: variantDef && feature in variantDef ? String(variantDef[feature]) : fmt(allowedValues(contract, feature)), actual: "(missing)", message: `Required feature "${feature}" was not reported` });
  }

  if (input.checkConstraints) for (const k of contract.constraints) {
    const applies = Object.entries(k.when).every(([f, vals]) => f in input.features && vals.some((v) => same(v, input.features[f]!)));
    if (!applies) continue;
    const trigger = Object.entries(k.when).map(([f]) => `${f}=${input.features[f]}`).join(", ");
    for (const [f, vals] of Object.entries(k.requires)) {
      if (!(f in input.features)) add({ code: "MISSING_REQUIRED_FEATURE", kind: "missing_feature", feature: f, constraintId: k.id, expected: fmt(vals), actual: "(missing)", message: `${trigger} requires ${f}=${fmt(vals)}, but ${f} was not reported` });
      else if (!vals.some((v) => same(v, input.features[f]!))) add({ code: "COMBINATION_VIOLATION", kind: "constraint_requires", feature: f, constraintId: k.id, expected: fmt(vals), actual: String(input.features[f]), message: k.message ?? `${trigger} requires ${f}=${fmt(vals)} but ${f} is ${input.features[f]}` });
    }
    for (const [f, vals] of Object.entries(k.forbids)) {
      if (f in input.features && vals.some((v) => same(v, input.features[f]!))) add({ code: "COMBINATION_VIOLATION", kind: "constraint_forbids", feature: f, constraintId: k.id, expected: `not ${fmt(vals)}`, actual: String(input.features[f]), message: k.message ?? `${trigger} forbids ${f}=${fmt(vals)}` });
    }
  }

  const status = findings.reduce<CombinationCode>((worst, f) => (SEVERITY[f.code] > SEVERITY[worst] ? f.code : worst), "COMBINATION_VALID");
  return { status, variant: input.variant, findings };
}

/** Merges the features several surfaces reported for one subject; the same feature with different values is a contradiction. */
export function mergeSurfaceFeatures(reports: { surfaceId: string; features: Record<string, FeatureValue> }[]): { features: Record<string, FeatureValue>; conflicts: CombinationFinding[] } {
  const features: Record<string, FeatureValue> = {};
  const owner: Record<string, string> = {};
  const conflicts: CombinationFinding[] = [];
  for (const r of reports) for (const [f, v] of Object.entries(r.features)) {
    if (!(f in features)) { features[f] = v; owner[f] = r.surfaceId; continue; }
    if (!same(features[f]!, v)) conflicts.push({ code: "COMBINATION_VIOLATION", kind: "contradictory_state", feature: f, constraintId: null, expected: `${f}=${features[f]} (reported by ${owner[f]})`, actual: `${f}=${v} (reported by ${r.surfaceId})`, message: `Surfaces ${owner[f]} and ${r.surfaceId} report different values for ${f}` });
  }
  return { features, conflicts };
}
