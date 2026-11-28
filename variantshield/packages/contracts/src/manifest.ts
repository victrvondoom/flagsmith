import { parse as parseYaml } from "yaml";
import { GUARDRAIL_IDS, fmt, type Constraint, type Contract, type ContractIssue, type FeatureValue, type ParseOutcome, type Surface } from "./types.ts";

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KEY = /^[A-Za-z0-9_.:-]{1,128}$/;
const KNOWN_TOP = new Set(["contract", "experiment", "identity", "surfaces", "variants", "constraints", "freshness", "guardrails"]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isScalar = (v: unknown): v is FeatureValue => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const same = (a: FeatureValue, b: FeatureValue): boolean => a === b;
const intersects = (a: FeatureValue[], b: FeatureValue[]): boolean => a.some((x) => b.some((y) => same(x, y)));
const subset = (a: FeatureValue[], b: FeatureValue[]): boolean => a.every((x) => b.some((y) => same(x, y)));

/** Parses YAML or JSON text into a value. Errors carry the position so the CLI can point at the problem. */
export function parseManifestText(text: string): { ok: true; value: unknown } | { ok: false; issue: ContractIssue } {
  try {
    return { ok: true, value: parseYaml(text, { maxAliasCount: 20, strict: true, uniqueKeys: true }) };
  } catch (e) {
    const err = e as { message?: string; linePos?: { line: number; col: number }[] };
    const pos = err.linePos?.[0];
    return { ok: false, issue: { path: pos ? `line ${pos.line}, column ${pos.col}` : "$", code: "CONTRACT_INVALID", severity: "error", message: `Not valid YAML/JSON: ${(err.message ?? "parse error").split("\n")[0]}` } };
  }
}

/** Validates an already-parsed manifest and normalises it into a Contract. Never throws. */
export function parseContract(input: unknown): ParseOutcome {
  const issues: ContractIssue[] = [];
  const err = (path: string, message: string): void => void issues.push({ path, code: "CONTRACT_INVALID", severity: "error", message });
  const warn = (path: string, message: string): void => void issues.push({ path, code: "CONTRACT_INVALID", severity: "warning", message });

  if (typeof input === "string") {
    const t = parseManifestText(input);
    if (!t.ok) return { ok: false, issues: [t.issue] };
    input = t.value;
  }
  if (!isObj(input)) return { ok: false, issues: [{ path: "$", code: "CONTRACT_INVALID", severity: "error", message: "The manifest must be a mapping with contract, experiment, surfaces and variants" }] };
  for (const k of Object.keys(input)) if (!KNOWN_TOP.has(k)) warn(k, `Unknown top-level key "${k}" is ignored`);

  const str = (obj: Record<string, unknown>, k: string, path: string, re: RegExp | null = null, required = true): string | null => {
    const v = obj[k];
    if (v === undefined || v === null || v === "") { if (required) err(`${path}.${k}`, "is required"); return null; }
    if (typeof v !== "string" || (re && !re.test(v))) { err(`${path}.${k}`, re ? `must match ${re}` : "must be a string"); return null; }
    return v;
  };

  // contract
  const c = isObj(input.contract) ? input.contract : (err("contract", "is required (id and version)"), {});
  const id = str(c, "id", "contract", SLUG);
  const version = c.version;
  if (!Number.isInteger(version) || (version as number) < 1) err("contract.version", "must be an integer >= 1");

  // experiment
  const e = isObj(input.experiment) ? input.experiment : (err("experiment", "is required (key, assignment_flag, environment)"), {});
  const expKey = str(e, "key", "experiment", KEY);
  const flag = str(e, "assignment_flag", "experiment", KEY);
  const environment = str(e, "environment", "experiment", KEY);
  const fp = e.environment_fingerprint === undefined ? null : typeof e.environment_fingerprint === "string" && /^[a-f0-9]{8,64}$/.test(e.environment_fingerprint) ? e.environment_fingerprint : (err("experiment.environment_fingerprint", "must be a lowercase hex string (see `variantshield env-fingerprint`)"), null);
  const fxid = e.flagsmith_experiment_id === undefined ? null : Number.isInteger(e.flagsmith_experiment_id) && (e.flagsmith_experiment_id as number) > 0 ? (e.flagsmith_experiment_id as number) : (err("experiment.flagsmith_experiment_id", "must be a positive integer"), null);

  // identity
  const idn = input.identity === undefined ? {} : isObj(input.identity) ? input.identity : (err("identity", "must be a mapping"), {});
  const strategy = idn.strategy ?? "canonical_subject_id";
  if (strategy !== "canonical_subject_id") err("identity.strategy", 'only "canonical_subject_id" is supported');
  const requireSame = idn.require_same_subject === undefined ? true : typeof idn.require_same_subject === "boolean" ? idn.require_same_subject : (err("identity.require_same_subject", "must be true or false"), true);

  // variants
  const variants: Contract["variants"] = {};
  if (!isObj(input.variants) || Object.keys(input.variants).length === 0) err("variants", "at least one variant with feature values is required");
  else {
    for (const [name, feats] of Object.entries(input.variants)) {
      if (!KEY.test(name)) err(`variants.${name}`, "variant names may only contain letters, digits, _ . : -");
      if (!isObj(feats) || Object.keys(feats).length === 0) { err(`variants.${name}`, "must map at least one feature to a value"); continue; }
      const map: Record<string, FeatureValue> = {};
      for (const [f, v] of Object.entries(feats)) {
        if (!KEY.test(f)) err(`variants.${name}.${f}`, "invalid feature key");
        else if (!isScalar(v)) err(`variants.${name}.${f}`, "must be a string, number or boolean");
        else map[f] = v;
      }
      variants[name] = map;
    }
    if (Object.keys(variants).length < 2) warn("variants", "an experiment normally needs a control and at least one treatment");
  }
  const universe = new Set(Object.values(variants).flatMap((m) => Object.keys(m)));
  for (const [name, m] of Object.entries(variants)) for (const f of universe) if (!(f in m)) err(`variants.${name}`, `is missing feature "${f}" that other variants define`);
  const allowed = (f: string): FeatureValue[] => [...new Map(Object.values(variants).filter((m) => f in m).map((m) => [String(m[f]), m[f] as FeatureValue])).values()];

  // surfaces
  const surfaces: Surface[] = [];
  if (!Array.isArray(input.surfaces) || input.surfaces.length === 0) err("surfaces", "at least one surface is required");
  else {
    const seen = new Set<string>();
    input.surfaces.forEach((s, i) => {
      const p = `surfaces[${i}]`;
      if (!isObj(s)) return err(p, "must be a mapping with an id");
      const sid = str(s, "id", p, SLUG);
      if (sid && seen.has(sid)) err(`${p}.id`, `duplicate surface id "${sid}"`);
      if (sid) seen.add(sid);
      const domain = typeof s.domain === "string" && s.domain ? s.domain : sid ?? "";
      const required = s.required === undefined ? true : typeof s.required === "boolean" ? s.required : (err(`${p}.required`, "must be true or false"), true);
      let features: string[] | null = null;
      if (s.features !== undefined) {
        if (!Array.isArray(s.features) || s.features.some((f) => typeof f !== "string")) err(`${p}.features`, "must be a list of feature keys");
        else {
          features = s.features as string[];
          for (const f of features) if (!universe.has(f)) err(`${p}.features`, `unknown feature "${f}" (not defined by any variant)`);
        }
      }
      if (sid) surfaces.push({ id: sid, domain, required, features });
    });
    if (surfaces.length < 2) warn("surfaces", "a cross-surface contract normally lists two or more surfaces");
    const covered = new Set(surfaces.flatMap((s) => s.features ?? [...universe]));
    for (const f of universe) if (!covered.has(f)) warn("surfaces", `no surface reports feature "${f}", so it can never be observed`);
  }

  // constraints
  const constraints: Constraint[] = [];
  if (input.constraints !== undefined && !Array.isArray(input.constraints)) err("constraints", "must be a list");
  else (input.constraints as unknown[] | undefined)?.forEach((raw, i) => {
    const p = `constraints[${i}]`;
    if (!isObj(raw)) return err(p, "must be a mapping with when and requires/forbids");
    const clause = (k: "when" | "requires" | "forbids"): Record<string, FeatureValue[]> => {
      const out: Record<string, FeatureValue[]> = {};
      const v = raw[k];
      if (v === undefined) return out;
      if (!isObj(v)) { err(`${p}.${k}`, "must be a mapping of feature to value(s)"); return out; }
      for (const [f, val] of Object.entries(v)) {
        const list = Array.isArray(val) ? val : [val];
        if (list.length === 0 || !list.every(isScalar)) { err(`${p}.${k}.${f}`, "must be a value or a non-empty list of values"); continue; }
        if (!universe.has(f)) { err(`${p}.${k}.${f}`, `unknown feature "${f}"`); continue; }
        const ok = allowed(f);
        for (const x of list as FeatureValue[]) if (!ok.some((a) => same(a, x))) err(`${p}.${k}.${f}`, `value "${x}" is not one of the values the variants define for ${f} (${fmt(ok)})`);
        out[f] = list as FeatureValue[];
      }
      return out;
    };
    const when = clause("when"), requires = clause("requires"), forbids = clause("forbids");
    if (Object.keys(when).length === 0) err(`${p}.when`, "is required and must name at least one feature");
    if (Object.keys(requires).length === 0 && Object.keys(forbids).length === 0) err(p, "needs requires and/or forbids");
    for (const f of Object.keys(requires)) if (forbids[f] && subset(requires[f]!, forbids[f]!)) err(p, `requires and forbids the same value(s) for "${f}"`);
    constraints.push({ id: typeof raw.id === "string" && raw.id ? raw.id : `c${i + 1}`, when, requires, forbids, message: typeof raw.message === "string" ? raw.message : null });
  });
  const ids = constraints.map((x) => x.id);
  ids.forEach((x, i) => { if (ids.indexOf(x) !== i) err("constraints", `duplicate constraint id "${x}"`); });

  // Contradictions between constraints that can apply together.
  for (let i = 0; i < constraints.length; i++) for (let j = i + 1; j < constraints.length; j++) {
    const a = constraints[i]!, b = constraints[j]!;
    const compatible = Object.keys(a.when).every((f) => !(f in b.when) || intersects(a.when[f]!, b.when[f]!));
    if (!compatible) continue;
    for (const f of Object.keys(a.requires)) {
      if (b.requires[f] && !intersects(a.requires[f]!, b.requires[f]!)) err("constraints", `"${a.id}" and "${b.id}" can apply together but require different values of "${f}" (${fmt(a.requires[f])} vs ${fmt(b.requires[f])})`);
      if (b.forbids[f] && subset(a.requires[f]!, b.forbids[f]!)) err("constraints", `"${a.id}" requires ${f}=${fmt(a.requires[f])} but "${b.id}" forbids it under overlapping conditions`);
    }
    for (const f of Object.keys(b.requires)) if (a.forbids[f] && subset(b.requires[f]!, a.forbids[f]!)) err("constraints", `"${b.id}" requires ${f}=${fmt(b.requires[f])} but "${a.id}" forbids it under overlapping conditions`);
  }
  // Every variant must satisfy the constraints itself, otherwise the contract contradicts its own definition.
  for (const [name, m] of Object.entries(variants)) for (const k of constraints) {
    if (!Object.entries(k.when).every(([f, vals]) => f in m && vals.some((v) => same(v, m[f]!)))) continue;
    for (const [f, vals] of Object.entries(k.requires)) if (!(f in m) || !vals.some((v) => same(v, m[f]!))) err(`variants.${name}`, `violates constraint "${k.id}": ${f} must be ${fmt(vals)} but the variant defines ${fmt(m[f])}`);
    for (const [f, vals] of Object.entries(k.forbids)) if (f in m && vals.some((v) => same(v, m[f]!))) err(`variants.${name}`, `violates constraint "${k.id}": ${f} must not be ${fmt(vals)}`);
  }

  // freshness
  const fr = input.freshness === undefined ? {} : isObj(input.freshness) ? input.freshness : (err("freshness", "must be a mapping"), {});
  const sec = (k: string, d: number): number => {
    const v = fr[k];
    if (v === undefined) return d;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > 7 * 86400) { err(`freshness.${k}`, "must be a number of seconds between 1 and 604800"); return d; }
    return v;
  };
  const maxAge = sec("max_age_seconds", 900), window = sec("correlation_window_seconds", 3600), grace = sec("missing_surface_grace_seconds", 120);
  if (window < maxAge) err("freshness", "correlation_window_seconds must be >= max_age_seconds");

  // guardrails
  const guardrails: string[] = [];
  if (input.guardrails !== undefined) {
    if (!Array.isArray(input.guardrails)) err("guardrails", "must be a list");
    else for (const g of input.guardrails) {
      if (typeof g !== "string" || !(GUARDRAIL_IDS as readonly string[]).includes(g)) err("guardrails", `unknown guardrail "${String(g)}" (known: ${GUARDRAIL_IDS.join(", ")})`);
      else guardrails.push(g);
    }
  }

  if (issues.some((i) => i.severity === "error") || id === null || expKey === null || flag === null || environment === null) return { ok: false, issues };
  return {
    ok: true, warnings: issues,
    contract: {
      id, version: version as number, description: typeof c.description === "string" ? c.description : "",
      experiment: { key: expKey, assignmentFlag: flag, environment, environmentFingerprint: fp, flagsmithExperimentId: fxid },
      identity: { strategy: "canonical_subject_id", requireSameSubject: requireSame },
      surfaces, variants, constraints, freshness: { maxAgeSeconds: maxAge, correlationWindowSeconds: window, missingSurfaceGraceSeconds: grace }, guardrails,
    },
  };
}

/** Stable JSON used for hashing and for storing the normalised manifest. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(value));
}
