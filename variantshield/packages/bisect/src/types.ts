/** A recent flag change that may have caused a regression. Pure data; no I/O. */
export interface Suspect {
  /** Stable id, e.g. `featurestate:123@2026-11-26T10:02:00Z` or `feature:new_tax_engine`. */
  id: string;
  /** Flagsmith feature name. */
  feature: string;
  /** Value served before the change (what a revert restores). */
  before: FlagValue;
  /** Value served after the change (what everyone sees now). */
  after: FlagValue;
  changedAt: number;
  /** Who or what made the change, as Flagsmith recorded it. */
  changedBy: string;
  /** Fraction of traffic the change reaches, 0..1 (1 for an environment default). */
  blastRadius: number;
  /** Optional free-form evidence the Profiler used, shown in the UI. */
  notes?: string[];
}

export interface FlagValue { enabled: boolean; value: string | number | boolean | null }

/** A culprit hypothesis: no suspect, one suspect, or a pair that only breaks together. */
export type Hypothesis = { kind: "none" } | { kind: "single"; ids: [string] } | { kind: "pair"; ids: [string, string] };

export interface Belief { hypothesis: Hypothesis; key: string; p: number }

export type ProbeVerdict = "healed" | "not_healed" | "inconclusive" | "harmful";

export interface ProbeDesign {
  /** Suspect ids whose change is reverted for the canary cohort only. */
  revert: string[];
  /** Expected information gain in bits. */
  expectedGainBits: number;
  /** Posterior mass of hypotheses this probe would heal. */
  healMass: number;
}

export interface CohortStats { n: number; failures: number }
