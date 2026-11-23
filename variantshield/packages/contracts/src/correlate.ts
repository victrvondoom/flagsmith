import { createHash } from "node:crypto";
import { mergeSurfaceFeatures, validateCombination } from "./combinations.ts";
import type { CombinationFinding, Contract, ContractObservation, ContractReport, ContractStatus, Finding, FindingCode, Severity, SubjectRow, SubjectSurfaceCell, SurfaceSummary } from "./types.ts";

export interface EvaluationContext {
  nowMs: number;
  /** Flagsmith's own current answer per subject (subject -> variant, null = Flagsmith returned nothing). Absent = not checked. */
  canonical?: ReadonlyMap<string, string | null>;
}

const PRECEDENCE: FindingCode[] = ["ASSIGNMENT_MISMATCH", "ENVIRONMENT_MISMATCH", "COMBINATION_VIOLATION", "UNKNOWN_VARIANT", "ASSIGNMENT_MISSING", "UNKNOWN_FEATURE_VALUE", "IDENTITY_UNLINKED", "MISSING_REQUIRED_FEATURE", "CONTRACT_VERSION_MISMATCH", "MISSING_SURFACE", "STALE_OBSERVATION"];
const short = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 10);

export function evaluateContract(contract: Contract, observations: readonly ContractObservation[], ctx: EvaluationContext): ContractReport {
  const now = ctx.nowMs;
  const windowStart = now - contract.freshness.correlationWindowSeconds * 1000;
  const maxAgeMs = contract.freshness.maxAgeSeconds * 1000;
  const graceMs = contract.freshness.missingSurfaceGraceSeconds * 1000;
  const surfaceIds = new Set(contract.surfaces.map((s) => s.id));
  const notes = [
    "Findings describe what surfaces reported. A missing observation is not proof that a service failed, and a mismatch is not proof of which side is wrong.",
    "Flagsmith buckets each environment independently, so assignments are only expected to match within one environment and one stable configuration.",
  ];

  const inWindow = observations.filter((o) => o.contractId === contract.id && o.observedAtMs > windowStart && surfaceIds.has(o.surfaceId));
  const findings: Finding[] = [];
  // Index by subject+surface so building each cell is O(its own findings), not O(all findings).
  const bySubjectSurface = new Map<string, Finding[]>();
  const add = (f: Omit<Finding, "contractVersion" | "dedupeKey"> & { key?: string }): void => {
    const { key, ...rest } = f;
    const made: Finding = { ...rest, contractVersion: contract.version, dedupeKey: `${contract.id}:${contract.version}:${f.code}:${f.surfaceId ?? "-"}:${f.subjectRef ?? "-"}:${short(key ?? `${f.expected}|${f.actual}`)}` };
    findings.push(made);
    const idx = `${f.subjectRef ?? ""}|${f.surfaceId ?? ""}`;
    const bucket = bySubjectSurface.get(idx);
    if (bucket) bucket.push(made); else bySubjectSurface.set(idx, [made]);
  };

  // Observations whose identity could not be verified are never guessed into a subject.
  const unlinked = inWindow.filter((o) => o.identityStatus !== "verified" || !o.subjectRef);
  const byReason = new Map<string, ContractObservation[]>();
  for (const o of unlinked) { const k = `${o.surfaceId}|${o.identityReason ?? "unverified"}`; byReason.set(k, [...(byReason.get(k) ?? []), o]); }
  for (const [k, list] of byReason) {
    const [surface, reason] = k.split("|") as [string, string];
    const latest = list.reduce((a, b) => (b.observedAtMs > a.observedAtMs ? b : a));
    add({ code: "IDENTITY_UNLINKED", severity: contract.identity.requireSameSubject ? "error" : "warning", surfaceId: surface, subjectRef: null, observedAtMs: latest.observedAtMs, expected: "a verified canonical subject token", actual: `identity ${reason} (${list.length} observation${list.length === 1 ? "" : "s"})`, message: `${surface} reported ${list.length} observation(s) whose identity could not be verified (${reason}). They cannot be correlated and are excluded from the matrix.`, evidence: { observationIds: list.slice(0, 20).map((o) => o.observationId), count: list.length, reason }, key: reason });
  }

  const linked = inWindow.filter((o) => o.identityStatus === "verified" && o.subjectRef);
  const bySubject = new Map<string, ContractObservation[]>();
  for (const o of linked) bySubject.set(o.subjectRef!, [...(bySubject.get(o.subjectRef!) ?? []), o]);

  const rows: SubjectRow[] = [];
  const surfaceStats = new Map<string, { obs: number; subjects: Set<string>; errors: number; warnings: number; last: number | null; incomplete: number }>(contract.surfaces.map((s) => [s.id, { obs: 0, subjects: new Set(), errors: 0, warnings: 0, last: null, incomplete: 0 }]));
  const cellCodes = new Map<string, FindingCode[]>();
  const mark = (subject: string, surface: string, code: FindingCode): void => void cellCodes.set(`${subject}|${surface}`, [...(cellCodes.get(`${subject}|${surface}`) ?? []), code]);

  for (const [subject, list] of bySubject) {
    const latest = new Map<string, ContractObservation>();
    for (const o of list) { const cur = latest.get(o.surfaceId); if (!cur || o.observedAtMs > cur.observedAtMs) latest.set(o.surfaceId, o); }
    const firstSeen = Math.min(...list.map((o) => o.observedAtMs));
    const canonical = ctx.canonical?.get(subject);
    const forSurface = (id: string): ContractObservation | undefined => latest.get(id);

    for (const o of latest.values()) {
      const st = surfaceStats.get(o.surfaceId)!;
      st.obs += list.filter((x) => x.surfaceId === o.surfaceId).length; st.subjects.add(subject); st.last = Math.max(st.last ?? 0, o.observedAtMs);
      if (o.contractVersion !== contract.version) { add({ code: "CONTRACT_VERSION_MISMATCH", severity: "warning", surfaceId: o.surfaceId, subjectRef: subject, observedAtMs: o.observedAtMs, expected: `v${contract.version}`, actual: `v${o.contractVersion}`, message: `${o.surfaceId} reported against contract v${o.contractVersion}; evaluating v${contract.version}`, evidence: { observationIds: [o.observationId] } }); mark(subject, o.surfaceId, "CONTRACT_VERSION_MISMATCH"); }
      if (now - o.observedAtMs > maxAgeMs) { add({ code: "STALE_OBSERVATION", severity: "warning", surfaceId: o.surfaceId, subjectRef: subject, observedAtMs: o.observedAtMs, expected: `observation newer than ${contract.freshness.maxAgeSeconds}s`, actual: `${Math.round((now - o.observedAtMs) / 1000)}s old`, message: `Latest observation from ${o.surfaceId} is older than the freshness limit; it may be outdated rather than wrong.`, evidence: { observationIds: [o.observationId], ageSeconds: Math.round((now - o.observedAtMs) / 1000) }, key: "stale" }); mark(subject, o.surfaceId, "STALE_OBSERVATION"); }
      const pinned = contract.experiment.environmentFingerprint;
      if (o.environment !== contract.experiment.environment) { add({ code: "ENVIRONMENT_MISMATCH", severity: "error", surfaceId: o.surfaceId, subjectRef: subject, observedAtMs: o.observedAtMs, expected: contract.experiment.environment, actual: o.environment, message: `${o.surfaceId} evaluated against environment "${o.environment}", the contract expects "${contract.experiment.environment}". Flagsmith buckets environments independently, so assignments need not match.`, evidence: { observationIds: [o.observationId] } }); mark(subject, o.surfaceId, "ENVIRONMENT_MISMATCH"); }
      else if (pinned && o.envFingerprint !== pinned) { add({ code: "ENVIRONMENT_MISMATCH", severity: "error", surfaceId: o.surfaceId, subjectRef: subject, observedAtMs: o.observedAtMs, expected: `environment ${pinned}`, actual: `environment ${o.envFingerprint ?? "(not reported)"}`, message: `${o.surfaceId} used a different Flagsmith environment than the one pinned in the contract.`, evidence: { observationIds: [o.observationId] } }); mark(subject, o.surfaceId, "ENVIRONMENT_MISMATCH"); }
    }
    const fps = new Map<string, string[]>();
    for (const o of latest.values()) if (o.envFingerprint) fps.set(o.envFingerprint, [...(fps.get(o.envFingerprint) ?? []), o.surfaceId]);
    if (fps.size > 1 && !contract.experiment.environmentFingerprint) {
      const detail = [...fps].map(([fp, s]) => `${s.join("+")}=${fp}`).join("; ");
      add({ code: "ENVIRONMENT_MISMATCH", severity: "error", surfaceId: null, subjectRef: subject, observedAtMs: Math.max(...[...latest.values()].map((o) => o.observedAtMs)), expected: "one Flagsmith environment", actual: detail, message: `Surfaces evaluated this subject against different Flagsmith environments (${detail}).`, evidence: { surfaces: [...fps.values()].flat() }, key: detail });
      for (const s of [...fps.values()].flat()) mark(subject, s, "ENVIRONMENT_MISMATCH");
    }

    // Assignment parity.
    const variants = new Map<string, string[]>();
    for (const o of latest.values()) {
      if (o.assignedVariant === null) { add({ code: "ASSIGNMENT_MISSING", severity: "error", surfaceId: o.surfaceId, subjectRef: subject, observedAtMs: o.observedAtMs, expected: "a Flagsmith assignment", actual: "(none)", message: `${o.surfaceId} did not obtain an assignment from Flagsmith for this subject.`, evidence: { observationIds: [o.observationId] } }); mark(subject, o.surfaceId, "ASSIGNMENT_MISSING"); continue; }
      variants.set(o.assignedVariant, [...(variants.get(o.assignedVariant) ?? []), o.surfaceId]);
    }
    if (variants.size > 1) {
      const detail = [...variants].map(([v, s]) => `${s.join("+")}=${v}`).join(", ");
      add({ code: "ASSIGNMENT_MISMATCH", severity: "error", surfaceId: null, subjectRef: subject, observedAtMs: Math.max(...[...latest.values()].map((o) => o.observedAtMs)), expected: "the same variant on every surface", actual: detail, message: `Surfaces report different variants for the same subject: ${detail}.`, evidence: { variants: Object.fromEntries(variants), observationIds: [...latest.values()].map((o) => o.observationId) }, key: detail });
      for (const s of [...variants.values()].flat()) mark(subject, s, "ASSIGNMENT_MISMATCH");
    }
    if (canonical !== undefined) for (const o of latest.values()) {
      if (o.assignedVariant !== null && canonical !== null && o.assignedVariant !== canonical) { add({ code: "ASSIGNMENT_MISMATCH", severity: "error", surfaceId: o.surfaceId, subjectRef: subject, observedAtMs: o.observedAtMs, expected: `${canonical} (Flagsmith now)`, actual: o.assignedVariant, message: `${o.surfaceId} reported "${o.assignedVariant}" but Flagsmith currently assigns "${canonical}" to this subject. The assignment may have changed (weights, targeting) or the surface used another identity.`, evidence: { observationIds: [o.observationId], source: "flagsmith_reverify" }, key: `vs-flagsmith:${canonical}:${o.assignedVariant}` }); mark(subject, o.surfaceId, "ASSIGNMENT_MISMATCH"); }
    }

    const distinct = [...variants.keys()];
    const reference = canonical ?? (distinct.length === 1 ? distinct[0]! : null);
    if (reference !== null && !contract.variants[reference]) {
      add({ code: "UNKNOWN_VARIANT", severity: "error", surfaceId: null, subjectRef: subject, observedAtMs: Math.max(...[...latest.values()].map((o) => o.observedAtMs)), expected: Object.keys(contract.variants).join(" | "), actual: reference, message: `Variant "${reference}" is not defined in contract v${contract.version}. Update the contract before judging its features.`, evidence: {}, key: reference });
    } else if (reference !== null) {
      // Per-surface checks against the reference variant, then cross-surface constraints on the merged view.
      const reports: { surfaceId: string; features: Record<string, never> | Record<string, string | number | boolean> }[] = [];
      for (const o of latest.values()) {
        if (o.assignedVariant !== reference) continue;
        reports.push({ surfaceId: o.surfaceId, features: o.features });
        const surface = contract.surfaces.find((s) => s.id === o.surfaceId)!;
        const res = validateCombination(contract, { variant: reference, features: o.features, requiredFeatures: surface.features ?? Object.keys(contract.variants[reference]!) });
        for (const f of res.findings) pushCombination(f, o);
      }
      const merged = mergeSurfaceFeatures(reports as { surfaceId: string; features: Record<string, string | number | boolean> }[]);
      const owner = (feature: string | null): string | null => (feature ? reports.find((r) => feature in r.features)?.surfaceId ?? null : null);
      for (const c of merged.conflicts) pushMerged(c, owner(c.feature), reports.map((r) => r.surfaceId));
      const res = validateCombination(contract, { variant: reference, features: merged.features, requiredFeatures: [], checkConstraints: true });
      // A constraint dependency is only "missing" if a surface that should report it did report, but without it.
      // If no responsible surface reported at all, MISSING_SURFACE already covers it; do not double-report.
      const responsibleReported = (feature: string | null): boolean => feature === null || contract.surfaces.some((s) => (s.features === null || s.features.includes(feature)) && latest.has(s.id));
      for (const f of res.findings.filter((x) => x.constraintId !== null && !(x.kind === "missing_feature" && !responsibleReported(x.feature)))) pushMerged(f, owner(f.feature), reports.map((r) => r.surfaceId));
    }

    function pushCombination(f: CombinationFinding, o: ContractObservation): void {
      const code = f.code === "CONTRACT_INVALID" ? "COMBINATION_VIOLATION" : f.code;
      add({ code, severity: code === "MISSING_REQUIRED_FEATURE" ? "warning" : "error", surfaceId: o.surfaceId, subjectRef: subject, observedAtMs: o.observedAtMs, expected: f.expected, actual: f.actual, message: `${o.surfaceId}: ${f.message}`, evidence: { observationIds: [o.observationId], kind: f.kind, feature: f.feature, constraintId: f.constraintId, variant: reference }, key: `${f.kind}:${f.feature}:${f.expected}:${f.actual}` });
      mark(subject, o.surfaceId, code);
    }
    function pushMerged(f: CombinationFinding, surface: string | null, involved: string[]): void {
      const code = f.code === "CONTRACT_INVALID" ? "COMBINATION_VIOLATION" : f.code;
      const obsIds = [...latest.values()].filter((o) => involved.includes(o.surfaceId)).map((o) => o.observationId);
      add({ code, severity: code === "MISSING_REQUIRED_FEATURE" ? "warning" : "error", surfaceId: surface, subjectRef: subject, observedAtMs: Math.max(...[...latest.values()].map((o) => o.observedAtMs)), expected: f.expected, actual: f.actual, message: f.message, evidence: { observationIds: obsIds, kind: f.kind, feature: f.feature, constraintId: f.constraintId, surfaces: involved, variant: reference }, key: `${f.kind}:${f.constraintId}:${f.feature}:${f.expected}:${f.actual}` });
      if (surface) mark(subject, surface, code);
    }

    // Coverage: delayed vs incomplete, never "failed".
    const cells: SubjectSurfaceCell[] = [];
    for (const s of contract.surfaces) {
      const o = forSurface(s.id);
      if (!o) {
        const delayed = now - firstSeen < graceMs;
        if (s.required) {
          add({ code: "MISSING_SURFACE", severity: delayed ? "info" : "warning", surfaceId: s.id, subjectRef: subject, observedAtMs: null, expected: "an observation for this subject", actual: delayed ? "not received yet (within grace period)" : "no observation received", message: delayed ? `No observation from ${s.id} yet; the grace period of ${contract.freshness.missingSurfaceGraceSeconds}s has not elapsed, so this may simply be delayed.` : `No observation from ${s.id} for this subject. This indicates incomplete coverage; it does not establish that the surface failed.`, evidence: { firstObservedAtMs: firstSeen, delayed }, key: delayed ? "delayed" : "missing" });
          if (!delayed) surfaceStats.get(s.id)!.incomplete++;
        }
        cells.push({ surfaceId: s.id, state: delayed ? "delayed" : "missing", variant: null, environment: null, envFingerprint: null, features: {}, observedAtMs: null, codes: s.required ? ["MISSING_SURFACE"] : [] });
        continue;
      }
      const codes = cellCodes.get(`${subject}|${s.id}`) ?? [];
      const sev = (bySubjectSurface.get(`${subject}|${s.id}`) ?? []).map((f) => f.severity);
      cells.push({ surfaceId: s.id, state: sev.includes("error") ? "violation" : sev.includes("warning") ? "warning" : "ok", variant: o.assignedVariant, environment: o.environment, envFingerprint: o.envFingerprint, features: o.features, observedAtMs: o.observedAtMs, codes });
    }
    rows.push({ subjectRef: subject, referenceVariant: reference, canonicalVariant: canonical, cells });
  }

  // Attribute subject-level findings (surfaceId null) to every surface involved for the summaries.
  for (const f of findings) {
    if (f.severity === "info") continue;
    const involved = f.surfaceId ? [f.surfaceId] : ((f.evidence.surfaces as string[] | undefined) ?? Object.values((f.evidence.variants as Record<string, string[]> | undefined) ?? {}).flat());
    for (const id of involved) { const st = surfaceStats.get(id); if (!st) continue; if (f.severity === "error") st.errors++; else st.warnings++; }
  }

  const surfaces: SurfaceSummary[] = contract.surfaces.map((s) => {
    const st = surfaceStats.get(s.id)!;
    const status = st.obs === 0 ? "no_data" : st.errors > 0 ? "violating" : st.warnings > 0 || st.incomplete > 0 ? "incomplete" : "compliant";
    return { id: s.id, domain: s.domain, required: s.required, status, observations: st.obs, subjects: st.subjects.size, errors: st.errors, warnings: st.warnings, lastObservedAtMs: st.last };
  });

  const real = findings.filter((f) => f.severity !== "info");
  const status: ContractStatus = linked.length === 0 && unlinked.length === 0 ? "NO_DATA" : real.some((f) => f.severity === "error") ? "CONTRACT_VIOLATION" : real.length > 0 ? "CONTRACT_INCOMPLETE" : linked.length === 0 ? "NO_DATA" : "CONTRACT_VALID";
  const primaryCode = real.length ? [...real].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) || PRECEDENCE.indexOf(a.code) - PRECEDENCE.indexOf(b.code))[0]!.code : null;
  const latestObservationAtMs = inWindow.length ? Math.max(...inWindow.map((o) => o.observedAtMs)) : null;
  return { contractId: contract.id, version: contract.version, status, primaryCode, generatedAtMs: now, latestObservationAtMs, linkedObservations: linked.length, unlinkedObservations: unlinked.length, surfaces, subjects: rows.sort((a, b) => a.subjectRef.localeCompare(b.subjectRef)), findings: findings.sort(sortFindings), notes };
}

const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
function sortFindings(a: Finding, b: Finding): number {
  return rank[a.severity] - rank[b.severity] || PRECEDENCE.indexOf(a.code) - PRECEDENCE.indexOf(b.code) || (b.observedAtMs ?? 0) - (a.observedAtMs ?? 0);
}
