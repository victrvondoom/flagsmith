import type { Contract, ContractObservation, DriftRecord, FeatureValue } from "./types.ts";

const json = (v: unknown): string => JSON.stringify(v);

/** What changed between two versions of a contract. Old versions are never rewritten; this only describes the difference. */
export function diffContracts(prev: Contract, next: Contract): DriftRecord[] {
  const out: DriftRecord[] = [];
  const all = next.surfaces.map((s) => s.id);
  const rec = (attribute: string, previous: unknown, current: unknown, severity: DriftRecord["severity"], affected: string[], message: string): void => {
    if (json(previous) !== json(current)) out.push({ attribute, previous: previous === null || previous === undefined ? null : typeof previous === "string" ? previous : json(previous), current: current === null || current === undefined ? null : typeof current === "string" ? current : json(current), severity, affectedSurfaces: affected, message, evidence: { contractId: next.id, previousVersion: prev.version, currentVersion: next.version } });
  };
  rec("contract.version", prev.version, next.version, "info", all, `Contract version changed from v${prev.version} to v${next.version}. Earlier observations and findings stay attached to their original version.`);
  rec("experiment.key", prev.experiment.key, next.experiment.key, "error", all, "The experiment key changed; observations for the old key no longer belong to this contract.");
  rec("experiment.assignment_flag", prev.experiment.assignmentFlag, next.experiment.assignmentFlag, "error", all, "The Flagsmith assignment flag changed; surfaces must be redeployed against the new flag.");
  rec("experiment.environment", prev.experiment.environment, next.experiment.environment, "error", all, "The environment changed. Flagsmith buckets environments independently, so assignments are not expected to carry over.");
  rec("experiment.environment_fingerprint", prev.experiment.environmentFingerprint, next.experiment.environmentFingerprint, "warning", all, "The pinned Flagsmith environment changed.");
  rec("identity.require_same_subject", prev.identity.requireSameSubject, next.identity.requireSameSubject, "warning", all, "Identity strictness changed.");
  const prevS = new Map(prev.surfaces.map((s) => [s.id, s])), nextS = new Map(next.surfaces.map((s) => [s.id, s]));
  for (const [id, s] of nextS) if (!prevS.has(id)) rec(`surface.${id}`, null, s.required ? "required" : "optional", s.required ? "warning" : "info", [id], `Surface ${id} was added to the contract.`);
  for (const [id] of prevS) if (!nextS.has(id)) rec(`surface.${id}`, "registered", null, "warning", [id], `Surface ${id} was removed from the contract.`);
  for (const [id, s] of nextS) { const p = prevS.get(id); if (p) { rec(`surface.${id}.required`, p.required, s.required, "warning", [id], `Surface ${id} is now ${s.required ? "required" : "optional"}.`); rec(`surface.${id}.features`, p.features, s.features, "warning", [id], `The features reported by ${id} changed.`); } }
  for (const v of new Set([...Object.keys(prev.variants), ...Object.keys(next.variants)])) {
    const a = prev.variants[v], b = next.variants[v];
    if (!a || !b) { rec(`variant.${v}`, a ? "defined" : null, b ? "defined" : null, "warning", all, `Variant ${v} was ${b ? "added" : "removed"}.`); continue; }
    for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) rec(`variant.${v}.${f}`, a[f] as FeatureValue | undefined, b[f] as FeatureValue | undefined, "warning", next.surfaces.filter((s) => s.features === null || s.features.includes(f)).map((s) => s.id), `Expected ${f} for variant ${v} changed.`);
  }
  const pc = new Map(prev.constraints.map((c) => [c.id, c])), nc = new Map(next.constraints.map((c) => [c.id, c]));
  for (const [id, c] of nc) rec(`constraint.${id}`, pc.has(id) ? json(pc.get(id)) : null, json(c), "warning", all, pc.has(id) ? `Constraint ${id} changed.` : `Constraint ${id} was added; a previously valid combination may now be a violation.`);
  for (const [id] of pc) if (!nc.has(id)) rec(`constraint.${id}`, "defined", null, "info", all, `Constraint ${id} was removed.`);
  rec("freshness", prev.freshness, next.freshness, "info", all, "Freshness settings changed.");
  return out;
}

/** Drift between two consecutive observations of the same surface for the same subject. */
export function observationDrift(prev: ContractObservation, next: ContractObservation): DriftRecord[] {
  if (prev.contractId !== next.contractId || prev.surfaceId !== next.surfaceId || prev.subjectRef !== next.subjectRef) return [];
  const out: DriftRecord[] = [];
  const base = { affectedSurfaces: [next.surfaceId], evidence: { contractId: next.contractId, subjectRef: next.subjectRef, previousObservationId: prev.observationId, observationId: next.observationId } };
  const rec = (attribute: string, a: string | null, b: string | null, severity: DriftRecord["severity"], message: string): void => { if (a !== b) out.push({ attribute, previous: a, current: b, severity, message, ...base }); };
  rec("assignment.variant", prev.assignedVariant, next.assignedVariant, "warning", `${next.surfaceId} now reports a different variant for the same subject. Assignment may have changed (weights, targeting) or the identity differs.`);
  rec("environment", prev.environment, next.environment, "error", `${next.surfaceId} switched Flagsmith environment.`);
  rec("environment.fingerprint", prev.envFingerprint, next.envFingerprint, "error", `${next.surfaceId} switched Flagsmith environment key.`);
  rec("contract.version", String(prev.contractVersion), String(next.contractVersion), "info", `${next.surfaceId} moved from contract v${prev.contractVersion} to v${next.contractVersion}.`);
  for (const f of new Set([...Object.keys(prev.features), ...Object.keys(next.features)])) rec(`feature.${f}`, f in prev.features ? String(prev.features[f]) : null, f in next.features ? String(next.features[f]) : null, "warning", `${next.surfaceId} changed the resolved value of ${f} for the same subject.`);
  return out;
}

/** Surfaces that were reporting in the previous period and are silent now. Silence is reported as drift, not as failure. */
export function silentSurfaces(contract: Contract, previouslyActive: ReadonlySet<string>, currentlyActive: ReadonlySet<string>): DriftRecord[] {
  return contract.surfaces.filter((s) => previouslyActive.has(s.id) && !currentlyActive.has(s.id)).map((s) => ({
    attribute: `surface.${s.id}.reporting`, previous: "reporting", current: "silent", severity: s.required ? "warning" : "info" as const, affectedSurfaces: [s.id],
    message: `${s.id} reported earlier but has sent no observation in the current window. This may be low traffic, a deploy, or a real outage; VariantShield cannot tell which.`,
    evidence: { contractId: contract.id, required: s.required },
  }));
}

/** Assignment configuration fingerprint changes (weights, enabled state, variant set). */
export function configDrift(contract: Contract, previousFingerprint: string | null, current: string, detail: unknown): DriftRecord[] {
  if (previousFingerprint === null || previousFingerprint === current) return [];
  return [{ attribute: "assignment.configuration", previous: previousFingerprint, current, severity: "warning", affectedSurfaces: contract.surfaces.map((s) => s.id),
    message: "The Flagsmith assignment configuration changed (for example variant weights). Changing weights during a running experiment can change which variant some identities receive, so assignment stability may have been affected.",
    evidence: { contractId: contract.id, detail } }];
}
