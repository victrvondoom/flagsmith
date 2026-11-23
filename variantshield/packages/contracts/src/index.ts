export * from "./types.ts";
export { parseContract, parseManifestText, canonicalJson } from "./manifest.ts";
export { validateCombination, mergeSurfaceFeatures, allowedValues, featureUniverse } from "./combinations.ts";
export type { CombinationInput } from "./combinations.ts";
export { deriveSubjectRef, issueIdentityToken, verifyIdentityToken, validateRawSubject, environmentFingerprint } from "./identity.ts";
export type { IdentityTokenPayload, TokenResult } from "./identity.ts";
export { evaluateContract } from "./correlate.ts";
export type { EvaluationContext } from "./correlate.ts";
export { diffContracts, observationDrift, silentSurfaces, configDrift } from "./drift.ts";
