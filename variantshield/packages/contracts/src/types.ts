export type FeatureValue = string | number | boolean;

export const GUARDRAIL_IDS = ["payment_failure_rate", "duplicate_submission_rate", "http_5xx_rate", "checkout_p95_latency_ms"] as const;

export interface Surface {
  id: string;
  domain: string;
  /** A required surface that never reports leaves the contract incomplete. */
  required: boolean;
  /** Features this surface resolves and must report. null = every feature in the contract. */
  features: string[] | null;
}

export interface Constraint {
  id: string;
  /** Feature -> allowed values that make the rule apply. All entries must match. */
  when: Record<string, FeatureValue[]>;
  requires: Record<string, FeatureValue[]>;
  forbids: Record<string, FeatureValue[]>;
  message: string | null;
}

export interface Contract {
  id: string;
  version: number;
  description: string;
  experiment: {
    key: string;
    assignmentFlag: string;
    /** Environment name, e.g. "production". */
    environment: string;
    /** Optional pin of the Flagsmith environment (fingerprint of its client key, see identity.ts). */
    environmentFingerprint: string | null;
    flagsmithExperimentId: number | null;
  };
  identity: { strategy: "canonical_subject_id"; requireSameSubject: boolean };
  surfaces: Surface[];
  variants: Record<string, Record<string, FeatureValue>>;
  constraints: Constraint[];
  freshness: { maxAgeSeconds: number; correlationWindowSeconds: number; missingSurfaceGraceSeconds: number };
  /** Names of guardrail metrics (from the reliability engine) this contract is tied to. */
  guardrails: string[];
}

export interface ContractIssue {
  path: string;
  code: "CONTRACT_INVALID";
  severity: "error" | "warning";
  message: string;
}

export type ParseOutcome = { ok: true; contract: Contract; warnings: ContractIssue[] } | { ok: false; issues: ContractIssue[] };

export type CombinationCode = "COMBINATION_VALID" | "COMBINATION_VIOLATION" | "MISSING_REQUIRED_FEATURE" | "UNKNOWN_FEATURE_VALUE" | "CONTRACT_INVALID";

export interface CombinationFinding {
  code: Exclude<CombinationCode, "COMBINATION_VALID">;
  kind: "variant_value" | "constraint_requires" | "constraint_forbids" | "contradictory_state" | "missing_feature" | "unknown_feature" | "unknown_value" | "unknown_variant";
  feature: string | null;
  constraintId: string | null;
  expected: string;
  actual: string;
  message: string;
}

export interface CombinationResult {
  status: CombinationCode;
  variant: string | null;
  findings: CombinationFinding[];
}

export const fmt = (v: FeatureValue | FeatureValue[] | undefined): string => (v === undefined ? "(missing)" : Array.isArray(v) ? v.join(" | ") : String(v));

export type FindingCode =
  | "ASSIGNMENT_MISMATCH" | "ASSIGNMENT_MISSING" | "ENVIRONMENT_MISMATCH" | "IDENTITY_UNLINKED" | "CONTRACT_VERSION_MISMATCH"
  | "COMBINATION_VIOLATION" | "MISSING_REQUIRED_FEATURE" | "UNKNOWN_FEATURE_VALUE" | "UNKNOWN_VARIANT" | "MISSING_SURFACE" | "STALE_OBSERVATION";

export type Severity = "error" | "warning" | "info";

export interface ContractObservation {
  /** Idempotency key chosen by the reporting surface. */
  observationId: string;
  contractId: string;
  contractVersion: number;
  experimentKey: string;
  environment: string;
  /** Fingerprint of the Flagsmith environment the surface evaluated against (see identity.ts). */
  envFingerprint: string | null;
  assignmentFlag: string;
  /** The variant Flagsmith returned to this surface. null = no assignment was obtained. */
  assignedVariant: string | null;
  surfaceId: string;
  /** Verified pseudonymous subject. null when identity could not be verified (IDENTITY_UNLINKED). */
  subjectRef: string | null;
  identityStatus: "verified" | "unlinked";
  identityReason: string | null;
  observedAtMs: number;
  features: Record<string, FeatureValue>;
  source: "real" | "simulation";
}

export interface Finding {
  code: FindingCode;
  severity: Severity;
  surfaceId: string | null;
  subjectRef: string | null;
  observedAtMs: number | null;
  contractVersion: number;
  expected: string;
  actual: string;
  message: string;
  evidence: Record<string, unknown>;
  dedupeKey: string;
}

export interface DriftRecord {
  attribute: string;
  previous: string | null;
  current: string | null;
  severity: Severity;
  affectedSurfaces: string[];
  message: string;
  evidence: Record<string, unknown>;
}

export type SurfaceStatus = "compliant" | "violating" | "incomplete" | "no_data";
export type ContractStatus = "CONTRACT_VALID" | "CONTRACT_VIOLATION" | "CONTRACT_INCOMPLETE" | "NO_DATA";

export interface SurfaceSummary {
  id: string;
  domain: string;
  required: boolean;
  status: SurfaceStatus;
  observations: number;
  subjects: number;
  errors: number;
  warnings: number;
  lastObservedAtMs: number | null;
}

export interface SubjectSurfaceCell {
  surfaceId: string;
  state: "ok" | "violation" | "warning" | "missing" | "delayed";
  variant: string | null;
  environment: string | null;
  envFingerprint: string | null;
  features: Record<string, FeatureValue>;
  observedAtMs: number | null;
  codes: FindingCode[];
}

export interface SubjectRow {
  subjectRef: string;
  referenceVariant: string | null;
  canonicalVariant: string | null | undefined;
  cells: SubjectSurfaceCell[];
}

export interface ContractReport {
  contractId: string;
  version: number;
  status: ContractStatus;
  primaryCode: FindingCode | null;
  generatedAtMs: number;
  latestObservationAtMs: number | null;
  linkedObservations: number;
  unlinkedObservations: number;
  surfaces: SurfaceSummary[];
  subjects: SubjectRow[];
  findings: Finding[];
  notes: string[];
}
