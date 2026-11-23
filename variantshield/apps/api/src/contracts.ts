import { createHash } from "node:crypto";
import type { Ctx } from "./context.ts";
import { HttpError } from "./http.ts";
import type { Row } from "./db.ts";
import {
  canonicalJson, configDrift, deriveSubjectRef, diffContracts, evaluateContract, issueIdentityToken, observationDrift, parseContract, parseManifestText, silentSurfaces, validateRawSubject,
  verifyIdentityToken, type Contract, type ContractIssue, type ContractObservation, type ContractReport, type DriftRecord, type FeatureValue, type Finding,
} from "../../../packages/contracts/src/index.ts";
import { FlagsmithError } from "../../../packages/flagsmith-adapter/src/index.ts";

export interface StoredContract { contract: Contract; manifestHash: string; isSimulation: boolean; createdAt: number; createdBy: string }
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const j = <T>(v: unknown, d: T): T => { try { return v ? (JSON.parse(String(v)) as T) : d; } catch { return d; } };

/* ---------------------------------------------------------------- manifests */

export function validateManifest(input: unknown): { valid: boolean; issues: ContractIssue[]; contract: Contract | null } {
  const text = typeof input === "object" && input !== null && "yaml" in input && typeof (input as { yaml: unknown }).yaml === "string" ? (input as { yaml: string }).yaml : input;
  const r = parseContract(text);
  return r.ok ? { valid: true, issues: r.warnings, contract: r.contract } : { valid: false, issues: r.issues, contract: null };
}

function rowToStored(r: Row): StoredContract {
  // The column holds the normalised Contract written by registerContract (validated on the way in), not the user's manifest.
  const contract = JSON.parse(String(r.manifest)) as Contract;
  if (typeof contract?.id !== "string" || typeof contract.version !== "number" || !Array.isArray(contract.surfaces)) throw new HttpError(500, "stored_contract_invalid", `Stored contract ${r.contract_id} v${r.version} is unreadable`);
  return { contract, manifestHash: String(r.manifest_hash), isSimulation: Number(r.is_simulation) === 1, createdAt: Number(r.created_at), createdBy: String(r.created_by) };
}

export function latestContract(ctx: Ctx, contractId: string): StoredContract | null {
  const r = ctx.db.get("SELECT * FROM contracts WHERE contract_id = ? ORDER BY version DESC LIMIT 1", contractId);
  return r ? rowToStored(r) : null;
}

export function getContractVersion(ctx: Ctx, contractId: string, version?: number): StoredContract {
  const r = version === undefined ? ctx.db.get("SELECT * FROM contracts WHERE contract_id = ? ORDER BY version DESC LIMIT 1", contractId) : ctx.db.get("SELECT * FROM contracts WHERE contract_id = ? AND version = ?", contractId, version);
  if (!r) throw new HttpError(404, "contract_not_found", version === undefined ? `No contract "${contractId}"` : `No contract "${contractId}" version ${version}`);
  return rowToStored(r);
}

export function listContracts(ctx: Ctx): { id: string; latestVersion: number; versions: number[]; experiment: string; environment: string; isSimulation: boolean; surfaces: number; updatedAt: number }[] {
  const ids = ctx.db.all("SELECT DISTINCT contract_id FROM contracts ORDER BY contract_id").map((r) => String(r.contract_id));
  return ids.map((id) => {
    const versions = ctx.db.all("SELECT version FROM contracts WHERE contract_id = ? ORDER BY version", id).map((r) => Number(r.version));
    const latest = getContractVersion(ctx, id);
    return { id, latestVersion: latest.contract.version, versions, experiment: latest.contract.experiment.key, environment: latest.contract.experiment.environment, isSimulation: latest.isSimulation, surfaces: latest.contract.surfaces.length, updatedAt: latest.createdAt };
  });
}

const insertDrift = (ctx: Ctx, contractId: string, prev: number | null, cur: number, d: DriftRecord, source: "real" | "simulation", keyExtra = ""): boolean => {
  const key = `${contractId}:${prev ?? "-"}:${cur}:${d.attribute}:${sha(`${d.previous}|${d.current}|${keyExtra}`).slice(0, 12)}`;
  return ctx.db.run(
    `INSERT OR IGNORE INTO contract_drift (dedupe_key, contract_id, previous_version, current_version, attribute, previous_value, current_value, severity, affected_surfaces, message, evidence, detected_at, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    key, contractId, prev, cur, d.attribute, d.previous, d.current, d.severity, JSON.stringify(d.affectedSurfaces), d.message, JSON.stringify(d.evidence), ctx.now(), source,
  ).changes === 1;
};

/** Registers a contract version. Versions are immutable and append-only; changes against the previous version are recorded as drift. */
export function registerContract(ctx: Ctx, input: unknown, actor: string, opts: { simulation?: boolean } = {}): { stored: StoredContract; status: "created" | "unchanged"; drift: DriftRecord[]; warnings: ContractIssue[] } {
  const v = validateManifest(input);
  if (!v.valid || !v.contract) throw new HttpError(400, "contract_invalid", "The contract manifest is invalid", v.issues);
  const contract = v.contract;
  const hash = sha(canonicalJson(contract));
  const existing = ctx.db.get("SELECT * FROM contracts WHERE contract_id = ? AND version = ?", contract.id, contract.version);
  if (existing) {
    if (String(existing.manifest_hash) === hash) return { stored: rowToStored(existing), status: "unchanged", drift: [], warnings: v.issues };
    throw new HttpError(409, "contract_version_immutable", `Contract ${contract.id} v${contract.version} already exists with different content. Published versions are immutable; bump contract.version.`);
  }
  const prev = latestContract(ctx, contract.id);
  if (prev && contract.version < prev.contract.version) throw new HttpError(409, "version_not_increasing", `Contract ${contract.id} already has v${prev.contract.version}; new versions must be higher.`);
  if (prev && prev.isSimulation !== Boolean(opts.simulation)) throw new HttpError(409, "source_mismatch", "A contract id cannot switch between simulation and real");
  ctx.db.run("INSERT INTO contracts (contract_id, version, manifest, manifest_hash, is_simulation, created_at, created_by) VALUES (?,?,?,?,?,?,?)", contract.id, contract.version, canonicalJson(contract), hash, opts.simulation ? 1 : 0, ctx.now(), actor);
  const drift = prev ? diffContracts(prev.contract, contract) : [];
  const source = opts.simulation ? "simulation" : "real";
  for (const d of drift) insertDrift(ctx, contract.id, prev!.contract.version, contract.version, d, source);
  return { stored: getContractVersion(ctx, contract.id, contract.version), status: "created", drift, warnings: v.issues };
}

/* ---------------------------------------------------------------- identity */

export function issueIdentity(ctx: Ctx, body: unknown): { subjectRef: string; token: string; kind: string; expiresAt: number } {
  if (typeof body !== "object" || body === null) throw new HttpError(400, "invalid_body", "Body must be a JSON object");
  const b = body as { subject?: unknown; anonymousId?: unknown; ttlSeconds?: unknown };
  const kind = b.anonymousId !== undefined ? "anonymous" : "authenticated";
  const raw = kind === "anonymous" ? b.anonymousId : b.subject;
  const check = validateRawSubject(raw);
  if (!check.ok) throw new HttpError(400, "invalid_subject", check.reason);
  const ttl = Math.min(3600, Math.max(60, typeof b.ttlSeconds === "number" ? Math.floor(b.ttlSeconds) : 900));
  const subjectRef = deriveSubjectRef(ctx.cfg.identitySecret, kind, check.subject);
  const token = issueIdentityToken(ctx.cfg.identitySecret, subjectRef, kind, ctx.now(), ttl);
  return { subjectRef, token, kind, expiresAt: ctx.now() + ttl * 1000 };
}

export function verifyIdentity(ctx: Ctx, token: unknown): { valid: boolean; subjectRef?: string; kind?: string; expiresAt?: number; reason?: string } {
  const r = verifyIdentityToken(ctx.cfg.identitySecret, token, ctx.now());
  return r.ok ? { valid: true, subjectRef: r.sub, kind: r.kind, expiresAt: r.expiresAtMs } : { valid: false, reason: r.reason };
}

/* ---------------------------------------------------------------- observations */

export interface ObservationResult { index: number; observationId: string | null; status: "accepted" | "duplicate" | "rejected"; identity?: "verified" | "unlinked"; issues?: string[] }
const KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const ID_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;
export const MAX_OBSERVATION_BATCH = 200;

function parseTs(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) { const ms = Date.parse(v); return Number.isNaN(ms) ? null : ms; }
  return null;
}

export function ingestObservations(ctx: Ctx, batch: unknown, opts: { simulation?: boolean } = {}): { accepted: number; duplicate: number; rejected: number; unlinked: number; results: ObservationResult[] } {
  if (!Array.isArray(batch) || batch.length === 0) throw new HttpError(400, "validation_failed", "observations must be a non-empty array");
  if (batch.length > MAX_OBSERVATION_BATCH) throw new HttpError(400, "validation_failed", `at most ${MAX_OBSERVATION_BATCH} observations per request`);
  const out = { accepted: 0, duplicate: 0, rejected: 0, unlinked: 0, results: [] as ObservationResult[] };
  const now = ctx.now();
  const retentionMs = ctx.cfg.retentionDays * 86_400_000;
  const contractCache = new Map<string, StoredContract | null>();

  batch.forEach((raw, index) => {
    const issues: string[] = [];
    const reject = (id: string | null): void => { out.rejected++; out.results.push({ index, observationId: id, status: "rejected", issues }); };
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) { issues.push("observation must be a JSON object"); return reject(null); }
    const o = raw as Record<string, unknown>;
    const need = (k: string, re: RegExp): string | null => { const v = o[k]; if (typeof v !== "string" || !re.test(v)) { issues.push(`${k} is missing or malformed`); return null; } return v; };
    const observationId = need("observationId", ID_RE), contractId = need("contractId", /^[a-z0-9][a-z0-9_-]{0,63}$/), experimentKey = need("experimentKey", KEY_RE), environment = need("environment", KEY_RE);
    const assignmentFlag = need("assignmentFlag", KEY_RE), surfaceId = need("surfaceId", /^[a-z0-9][a-z0-9_-]{0,63}$/);
    const version = o.contractVersion;
    if (!Number.isInteger(version) || (version as number) < 1) issues.push("contractVersion must be a positive integer");
    const variant = o.assignedVariant === null || o.assignedVariant === undefined ? null : typeof o.assignedVariant === "string" && KEY_RE.test(o.assignedVariant) ? o.assignedVariant : (issues.push("assignedVariant is malformed"), null);
    const fp = o.envFingerprint === undefined || o.envFingerprint === null ? null : typeof o.envFingerprint === "string" && /^[a-f0-9]{8,64}$/.test(o.envFingerprint) ? o.envFingerprint : (issues.push("envFingerprint must be lowercase hex"), null);
    const ts = parseTs(o.observedAt);
    if (ts === null || ts < 1_577_836_800_000) issues.push("observedAt must be epoch ms or ISO-8601 after 2020");
    else if (ts > now + 300_000) issues.push("observedAt is in the future");
    else if (ts < now - retentionMs) issues.push("observedAt is older than the retention window");
    const features: Record<string, FeatureValue> = {};
    if (typeof o.features !== "object" || o.features === null || Array.isArray(o.features)) issues.push("features must be an object of feature -> value");
    else {
      const entries = Object.entries(o.features as Record<string, unknown>);
      if (entries.length > 32) issues.push("at most 32 features per observation");
      for (const [k, v] of entries) { if (!KEY_RE.test(k) || !(typeof v === "string" || typeof v === "number" || typeof v === "boolean")) issues.push(`feature "${k}" is malformed (value must be a string, number or boolean)`); else features[k] = v; }
    }
    for (const k of Object.keys(o)) if (!["observationId", "contractId", "contractVersion", "experimentKey", "environment", "envFingerprint", "assignmentFlag", "assignedVariant", "surfaceId", "identityToken", "observedAt", "features"].includes(k)) issues.push(`unknown field "${k}"${/email|name|phone|ip|user/i.test(k) ? " (personal data is not accepted)" : ""}`);
    if (issues.length || !observationId || !contractId || !experimentKey || !environment || !assignmentFlag || !surfaceId) return reject(observationId);

    const cacheKey = `${contractId}:${version}`;
    if (!contractCache.has(cacheKey)) { const r = ctx.db.get("SELECT * FROM contracts WHERE contract_id = ? AND version = ?", contractId, version as number); contractCache.set(cacheKey, r ? rowToStored(r) : null); }
    const stored = contractCache.get(cacheKey);
    if (!stored) { issues.push(`unknown contract ${contractId} v${version as number}`); return reject(observationId); }
    if (stored.isSimulation !== Boolean(opts.simulation)) { issues.push(stored.isSimulation ? "this contract is a simulation; real surfaces cannot report to it" : "simulated observations cannot be written to a real contract"); return reject(observationId); }
    const c = stored.contract;
    if (experimentKey !== c.experiment.key) issues.push(`experimentKey "${experimentKey}" does not match the contract ("${c.experiment.key}")`);
    if (assignmentFlag !== c.experiment.assignmentFlag) issues.push(`assignmentFlag "${assignmentFlag}" does not match the contract ("${c.experiment.assignmentFlag}")`);
    if (!c.surfaces.some((s) => s.id === surfaceId)) issues.push(`surface "${surfaceId}" is not registered in contract ${contractId} v${version as number}`);
    if (issues.length) return reject(observationId);

    // Identity is only trusted if the signed token verifies; nothing the client says about "who" is believed.
    const idr = verifyIdentityToken(ctx.cfg.identitySecret, o.identityToken, now);
    const subjectRef = idr.ok ? idr.sub : null;
    const obs: ContractObservation = { observationId, contractId, contractVersion: version as number, experimentKey, environment, envFingerprint: fp, assignmentFlag, assignedVariant: variant, surfaceId, subjectRef, identityStatus: idr.ok ? "verified" : "unlinked", identityReason: idr.ok ? null : idr.reason, observedAtMs: ts!, features, source: opts.simulation ? "simulation" : "real" };
    const hash = sha(canonicalJson({ ...obs, identityReason: null }));
    const ins = ctx.db.run(
      `INSERT OR IGNORE INTO contract_observations (observation_id, payload_hash, contract_id, contract_version, experiment_key, environment, env_fingerprint, assignment_flag, assigned_variant, surface_id, subject_ref, identity_status, identity_reason, observed_at, received_at, features, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      observationId, hash, contractId, obs.contractVersion, experimentKey, environment, fp, assignmentFlag, variant, surfaceId, subjectRef, obs.identityStatus, obs.identityReason, ts!, now, JSON.stringify(features), obs.source,
    );
    if (ins.changes === 0) {
      const prior = ctx.db.get("SELECT payload_hash FROM contract_observations WHERE observation_id = ?", observationId);
      if (String(prior?.payload_hash) === hash) { out.duplicate++; out.results.push({ index, observationId, status: "duplicate", identity: obs.identityStatus }); return; }
      issues.push("observationId already used for a different payload (idempotency conflict)");
      return reject(observationId);
    }
    out.accepted++;
    if (obs.identityStatus === "unlinked") out.unlinked++;
    out.results.push({ index, observationId, status: "accepted", identity: obs.identityStatus });
    if (subjectRef) {
      const prev = ctx.db.get("SELECT * FROM contract_observations WHERE contract_id = ? AND subject_ref = ? AND surface_id = ? AND observed_at < ? AND observation_id <> ? ORDER BY observed_at DESC LIMIT 1", contractId, subjectRef, surfaceId, ts!, observationId);
      if (prev) for (const d of observationDrift(rowToObservation(prev), obs)) insertDrift(ctx, contractId, obs.contractVersion, obs.contractVersion, d, obs.source, `${surfaceId}:${subjectRef}`);
    }
  });
  return out;
}

function rowToObservation(r: Row): ContractObservation {
  return {
    observationId: String(r.observation_id), contractId: String(r.contract_id), contractVersion: Number(r.contract_version), experimentKey: String(r.experiment_key), environment: String(r.environment),
    envFingerprint: r.env_fingerprint === null ? null : String(r.env_fingerprint), assignmentFlag: String(r.assignment_flag), assignedVariant: r.assigned_variant === null ? null : String(r.assigned_variant),
    surfaceId: String(r.surface_id), subjectRef: r.subject_ref === null ? null : String(r.subject_ref), identityStatus: r.identity_status === "verified" ? "verified" : "unlinked",
    identityReason: r.identity_reason === null ? null : String(r.identity_reason), observedAtMs: Number(r.observed_at), features: j(r.features, {}), source: r.source === "simulation" ? "simulation" : "real",
  };
}

export function loadObservations(ctx: Ctx, contractId: string, sinceMs: number, untilMs: number, limit = 20_000): ContractObservation[] {
  return ctx.db.all("SELECT * FROM contract_observations WHERE contract_id = ? AND observed_at > ? AND observed_at <= ? ORDER BY observed_at DESC LIMIT ?", contractId, sinceMs, untilMs, limit).map(rowToObservation);
}

/* ---------------------------------------------------------------- evaluation */

export interface ContractReportResponse {
  report: ContractReport;
  contract: Contract;
  source: "real" | "simulation";
  versions: number[];
  combinationMatrix: { features: string[]; variants: string[]; values: Record<string, Record<string, FeatureValue>>; constraints: Contract["constraints"] };
  /** Distinct resolved feature combinations seen across surfaces, with how many subjects had each and whether it is valid. */
  observedCombinations: { variant: string | null; features: Record<string, FeatureValue>; subjects: number; status: "valid" | "invalid" | "incomplete"; reasons: string[]; constraintIds: string[] }[];
  drift: ReturnType<typeof listDrift>;
  historicalFindings: number;
}

function observedCombinations(report: ContractReport): ContractReportResponse["observedCombinations"] {
  const groups = new Map<string, ContractReportResponse["observedCombinations"][number]>();
  for (const row of report.subjects) {
    const features: Record<string, FeatureValue> = {};
    for (const cell of row.cells) for (const [k, v] of Object.entries(cell.features)) if (!(k in features)) features[k] = v;
    const fs = report.findings.filter((f) => f.subjectRef === row.subjectRef && f.severity !== "info" && ["COMBINATION_VIOLATION", "UNKNOWN_FEATURE_VALUE", "MISSING_REQUIRED_FEATURE", "UNKNOWN_VARIANT"].includes(f.code));
    const status = fs.some((f) => f.severity === "error") ? "invalid" : fs.length ? "incomplete" : "valid";
    const key = `${row.referenceVariant}|${JSON.stringify(Object.entries(features).sort())}|${status}`;
    const g = groups.get(key) ?? { variant: row.referenceVariant, features, subjects: 0, status, reasons: [], constraintIds: [] };
    g.subjects++;
    for (const f of fs) { if (!g.reasons.includes(f.message)) g.reasons.push(f.message); const c = f.evidence.constraintId; if (typeof c === "string" && !g.constraintIds.includes(c)) g.constraintIds.push(c); }
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.subjects - a.subjects);
}

export function buildReport(ctx: Ctx, contractId: string, version?: number, canonical?: ReadonlyMap<string, string | null>): ContractReportResponse {
  const stored = getContractVersion(ctx, contractId, version);
  const c = stored.contract;
  const now = ctx.now();
  const obs = loadObservations(ctx, contractId, now - c.freshness.correlationWindowSeconds * 1000, now + 300_000);
  const report = evaluateContract(c, obs, { nowMs: now, ...(canonical ? { canonical } : {}) });
  const versions = ctx.db.all("SELECT version FROM contracts WHERE contract_id = ? ORDER BY version", contractId).map((r) => Number(r.version));
  const features = [...new Set(Object.values(c.variants).flatMap((m) => Object.keys(m)))];
  return {
    report, contract: c, source: stored.isSimulation ? "simulation" : "real", versions,
    combinationMatrix: { features, variants: Object.keys(c.variants), values: c.variants, constraints: c.constraints },
    observedCombinations: observedCombinations(report),
    drift: listDrift(ctx, contractId, 100),
    historicalFindings: Number(ctx.db.get("SELECT COUNT(*) AS n FROM contract_findings WHERE contract_id = ?", contractId)?.n ?? 0),
  };
}

const canonicalCache = new Map<string, { at: number; variant: string | null }>();

/** Re-verifies assignments with Flagsmith itself (live contracts only), records config drift and persists findings. */
export async function checkContract(ctx: Ctx, contractId: string, version?: number): Promise<ContractReportResponse & { persisted: { newFindings: number; updated: number; newDrift: number }; flagsmith: { verified: boolean; subjectsChecked: number; configFingerprint: string | null; note: string | null } }> {
  const stored = getContractVersion(ctx, contractId, version);
  const c = stored.contract;
  const now = ctx.now();
  const source = stored.isSimulation ? "simulation" : "real";
  let canonical: Map<string, string | null> | undefined;
  const flagsmith: { verified: boolean; subjectsChecked: number; configFingerprint: string | null; note: string | null } = { verified: false, subjectsChecked: 0, configFingerprint: null, note: null };
  let newDrift = 0;

  if (stored.isSimulation) flagsmith.note = "Simulation contract: Flagsmith is not contacted.";
  else if (!ctx.flagsmith) flagsmith.note = "Flagsmith is not configured; assignments were compared across surfaces only.";
  else {
    try {
      const subjects = [...new Set(loadObservations(ctx, contractId, now - c.freshness.correlationWindowSeconds * 1000, now + 300_000, 2000).map((o) => o.subjectRef).filter((s): s is string => s !== null))].slice(0, 100);
      canonical = new Map();
      for (const s of subjects) {
        const key = `${this_env(ctx)}:${c.experiment.assignmentFlag}:${s}`;
        const hit = canonicalCache.get(key);
        if (hit && now - hit.at < 60_000) { canonical.set(s, hit.variant); continue; }
        const a = await ctx.flagsmith.getIdentityAssignment(s, c.experiment.assignmentFlag);
        canonicalCache.set(key, { at: now, variant: a.variantKey });
        canonical.set(s, a.variantKey);
      }
      flagsmith.verified = true; flagsmith.subjectsChecked = subjects.length;
      try {
        const cfg = await ctx.flagsmith.getAssignmentConfig(c.experiment.assignmentFlag);
        flagsmith.configFingerprint = cfg.fingerprint;
        const last = ctx.db.get("SELECT fingerprint FROM assignment_config_snapshots WHERE contract_id = ? ORDER BY id DESC LIMIT 1", contractId);
        if (!last || String(last.fingerprint) !== cfg.fingerprint) ctx.db.run("INSERT INTO assignment_config_snapshots (contract_id, taken_at, fingerprint, config) VALUES (?,?,?,?)", contractId, now, cfg.fingerprint, JSON.stringify(cfg));
        for (const d of configDrift(c, last ? String(last.fingerprint) : null, cfg.fingerprint, { states: cfg.states })) if (insertDrift(ctx, contractId, c.version, c.version, d, source, cfg.fingerprint)) newDrift++;
      } catch (e) { flagsmith.note = `Assignment configuration unavailable: ${e instanceof FlagsmithError ? `${e.kind}` : "error"}`; }
    } catch (e) {
      canonical = undefined;
      flagsmith.note = `Flagsmith re-verification unavailable (${e instanceof FlagsmithError ? e.kind : "error"}); assignments were compared across surfaces only.`;
    }
  }

  // Surfaces that reported in the previous window but not the current one.
  const w = c.freshness.correlationWindowSeconds * 1000;
  const prevActive = new Set(loadObservations(ctx, contractId, now - 2 * w, now - w).map((o) => o.surfaceId));
  const curActive = new Set(loadObservations(ctx, contractId, now - w, now + 300_000).map((o) => o.surfaceId));
  for (const d of silentSurfaces(c, prevActive, curActive)) if (insertDrift(ctx, contractId, c.version, c.version, d, source, String(Math.floor(now / w)))) newDrift++;

  const built = buildReport(ctx, contractId, version, canonical);
  let newFindings = 0, updated = 0;
  ctx.db.tx(() => { for (const f of built.report.findings) { if (f.severity === "info") continue; if (persistFinding(ctx, f, source)) newFindings++; else updated++; } });
  return { ...built, persisted: { newFindings, updated, newDrift }, flagsmith, drift: listDrift(ctx, contractId, 100), historicalFindings: Number(ctx.db.get("SELECT COUNT(*) AS n FROM contract_findings WHERE contract_id = ?", contractId)?.n ?? 0) };
}
const this_env = (ctx: Ctx): string => ctx.cfg.flagsmith.environmentKey?.slice(0, 6) ?? "none";

function persistFinding(ctx: Ctx, f: Finding, source: "real" | "simulation"): boolean {
  const r = ctx.db.run(
    `INSERT OR IGNORE INTO contract_findings (dedupe_key, contract_id, contract_version, code, severity, surface_id, subject_ref, observed_at, detected_at, last_seen_at, expected, actual, message, evidence, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    f.dedupeKey, f.dedupeKey.split(":")[0]!, f.contractVersion, f.code, f.severity, f.surfaceId, f.subjectRef, f.observedAtMs, ctx.now(), ctx.now(), f.expected, f.actual, f.message, JSON.stringify(f.evidence), source,
  );
  if (r.changes === 1) return true;
  ctx.db.run("UPDATE contract_findings SET last_seen_at = ? WHERE dedupe_key = ?", ctx.now(), f.dedupeKey);
  return false;
}

export function listFindings(ctx: Ctx, contractId: string, opts: { version?: number; code?: string; limit?: number } = {}): unknown[] {
  const where = ["contract_id = ?"]; const params: (string | number)[] = [contractId];
  if (opts.version !== undefined) { where.push("contract_version = ?"); params.push(opts.version); }
  if (opts.code) { where.push("code = ?"); params.push(opts.code); }
  return ctx.db.all(`SELECT * FROM contract_findings WHERE ${where.join(" AND ")} ORDER BY detected_at DESC, id DESC LIMIT ?`, ...params, Math.min(opts.limit ?? 200, 1000)).map((r) => ({
    id: r.id, code: r.code, severity: r.severity, contractVersion: r.contract_version, surfaceId: r.surface_id, subjectRef: r.subject_ref, observedAt: r.observed_at, detectedAt: r.detected_at,
    lastSeenAt: r.last_seen_at, expected: r.expected, actual: r.actual, message: r.message, evidence: j(r.evidence, {}), source: r.source, evidenceRef: `finding:${r.id}`,
  }));
}

export function listDrift(ctx: Ctx, contractId: string, limit = 100): unknown[] {
  return ctx.db.all("SELECT * FROM contract_drift WHERE contract_id = ? ORDER BY detected_at DESC, id DESC LIMIT ?", contractId, limit).map((r) => ({
    id: r.id, attribute: r.attribute, previousVersion: r.previous_version, currentVersion: r.current_version, previous: r.previous_value, current: r.current_value, severity: r.severity,
    affectedSurfaces: j(r.affected_surfaces, []), message: r.message, evidence: j(r.evidence, {}), detectedAt: r.detected_at, source: r.source,
  }));
}

export { parseManifestText };
