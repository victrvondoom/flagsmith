import type { ExperimentResultSummary } from "../../verdict/src/index.ts";

export type FlagsmithExperimentStatus = "created" | "running" | "paused" | "completed";
export const EXPERIMENT_STATUSES: readonly FlagsmithExperimentStatus[] = ["created", "running", "paused", "completed"];

export interface FlagsmithExperiment {
  id: number;
  name: string;
  hypothesis: string;
  status: FlagsmithExperimentStatus;
  featureName: string | null;
  featureId: number | null;
  /** Multivariate option values, i.e. the variant keys other than the control default. */
  variantOptions: string[];
  createdAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string | null;
}

export interface VariantExposure {
  variant: string;
  identities: number;
}

export interface ExposureSnapshot {
  asOf: string | null;
  isFinal: boolean;
  excludedIdentities: number;
  variants: VariantExposure[];
}

export interface IdentityAssignment {
  featureKey: string;
  /** Flagsmith's served value for the feature; for multivariate flags this is the variant key. */
  variantKey: string | null;
  enabled: boolean;
  /** Why variantKey is null, when it is. */
  reason: "flag_not_found" | "flag_disabled" | "no_value" | null;
}

export interface ResultsSnapshot {
  asOf: string | null;
  isFinal: boolean;
  lastErrorAt: string | null;
  summary: ExperimentResultSummary;
}

export interface SdkEvent {
  event: string;
  featureName?: string;
  identifier: string;
  timestampMs: number;
  value?: unknown;
}

export interface FlagsmithClientConfig {
  /** Flagsmith API origin, e.g. http://localhost:8000. A trailing /api/v1 is tolerated. */
  baseUrl: string;
  /** Environment API key (client-side key, used for identities and events). */
  environmentKey: string;
  /** Management API credential; only needed for experiment reads and lifecycle control. Server-side only. */
  admin?: { scheme: "Api-Key" | "Token"; value: string };
  /** Environment API key used in management URLs; defaults to environmentKey. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  retry?: { retries: number; baseDelayMs: number; maxDelayMs: number };
  sleep?: (ms: number) => Promise<void>;
  /** Probability (0-1) above which Flagsmith's chance_to_win counts as a win. */
  winProbability?: number;
}
