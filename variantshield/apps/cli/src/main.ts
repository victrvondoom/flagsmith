#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { environmentFingerprint, parseContract, parseManifestText, type Contract, type ContractIssue } from "../../../packages/contracts/src/index.ts";

/**
 * variantshield CLI.
 *   contract validate --file x.yaml [--json]                 local schema + consistency checks (no network)
 *   contract register --file x.yaml                          publish a new immutable contract version
 *   contract check    --contract id [--version N] [--json]   re-verify with Flagsmith, persist findings, set the exit code
 *   contract report   --contract id [--version N] [--json]   read-only report
 *   contract surface-keys --contract id [--json]          per-surface reporting keys (secrets: give each surface only its own)
 *   env-fingerprint <flagsmith client key>                   value for experiment.environment_fingerprint
 *
 * Exit codes: 0 ok · 1 invalid contract or contract violation · 2 usage / connection / auth error · 3 incomplete or no data (use --allow-incomplete to treat as ok)
 * Environment: VARIANTSHIELD_URL (default http://127.0.0.1:8787), VARIANTSHIELD_ADMIN_TOKEN (never printed).
 */
const USAGE = `Usage:
  variantshield contract validate --file <manifest.yaml|json> [--json]
  variantshield contract register --file <manifest> [--json]
  variantshield contract check    --contract <id> [--version <n>] [--allow-incomplete] [--json]
  variantshield contract report   --contract <id> [--version <n>] [--json]
  variantshield contract surface-keys --contract <id> [--version <n>] [--json]   (prints secrets)
  variantshield env-fingerprint <flagsmith client-side environment key>

Environment: VARIANTSHIELD_URL, VARIANTSHIELD_ADMIN_TOKEN
Exit codes: 0 ok, 1 invalid or violation, 2 usage/connection error, 3 incomplete or no data`;

type Out = { json: boolean };
const print = (o: Out, human: string, data: unknown): void => console.log(o.json ? JSON.stringify(data, null, 2) : human);
const fail = (code: number, message: string, o: Out = { json: false }): never => {
  if (o.json) console.log(JSON.stringify({ error: message })); else console.error(message);
  process.exit(code);
};

function readManifest(file: string, o: Out): unknown {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch (e) { return fail(2, `Cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? "error"}`, o); }
  return text;
}

function describeContract(c: Contract): string {
  const features = [...new Set(Object.values(c.variants).flatMap((m) => Object.keys(m)))];
  const lines = [
    `Contract ${c.id} v${c.version}: experiment ${c.experiment.key} (flag ${c.experiment.assignmentFlag}, environment ${c.experiment.environment})`,
    `Identity: ${c.identity.strategy}${c.identity.requireSameSubject ? ", same subject required" : ""}`,
    `Surfaces (${c.surfaces.length}): ${c.surfaces.map((s) => `${s.id}${s.required ? "" : " (optional)"}${s.features ? ` [${s.features.join(", ")}]` : ""}`).join(", ")}`,
    `Variants: ${Object.keys(c.variants).join(", ")}`,
    `Features: ${features.join(", ")}`,
    `Constraints: ${c.constraints.length === 0 ? "none" : c.constraints.map((k) => k.id).join(", ")}`,
  ];
  return lines.join("\n");
}
const fmtIssue = (i: ContractIssue): string => `  ${i.severity === "error" ? "ERROR" : "warn "} ${i.path}: ${i.message}`;

async function api(method: string, path: string, body: unknown, o: Out): Promise<{ status: number; json: any }> {
  const token = process.env.VARIANTSHIELD_ADMIN_TOKEN;
  if (!token) return fail(2, "Set VARIANTSHIELD_ADMIN_TOKEN (and optionally VARIANTSHIELD_URL).", o);
  const base = (process.env.VARIANTSHIELD_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
  try {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (res.status === 401) return fail(2, "The admin token was not accepted.", o);
    return { status: res.status, json };
  } catch (e) {
    return fail(2, `Cannot reach VariantShield at ${base}: ${(e as Error).message}`, o);
  }
}

function describeReport(r: any): string {
  const rep = r.report;
  const lines = [`${rep.contractId} v${rep.version}: ${rep.status}${rep.primaryCode ? ` (${rep.primaryCode})` : ""}${r.source === "simulation" ? "  [SIMULATION]" : ""}`,
    `Observations: ${rep.linkedObservations} linked, ${rep.unlinkedObservations} unlinked; subjects: ${r.subjectsTotal ?? rep.subjects.length}${r.subjectsTotal > rep.subjects.length ? ` (showing ${rep.subjects.length}, violations first)` : ""}`, "", "Surface".padEnd(18) + "Status".padEnd(12) + "Subjects".padEnd(10) + "Errors".padEnd(8) + "Warnings"];
  for (const s of rep.surfaces) lines.push(s.id.padEnd(18) + s.status.padEnd(12) + String(s.subjects).padEnd(10) + String(s.errors).padEnd(8) + s.warnings);
  const shown = rep.findings.filter((f: any) => f.severity !== "info").slice(0, 12);
  if (shown.length) lines.push("", `Findings (${rep.findings.filter((f: any) => f.severity !== "info").length}):`);
  for (const f of shown) lines.push(`  ${f.severity.toUpperCase().padEnd(7)} ${f.code}${f.surfaceId ? ` [${f.surfaceId}]` : ""}: expected ${f.expected}; actual ${f.actual}`);
  if (r.flagsmith?.note) lines.push("", `Note: ${r.flagsmith.note}`);
  return lines.join("\n");
}

const exitForStatus = (status: string, allowIncomplete: boolean): number => (status === "CONTRACT_VALID" ? 0 : status === "CONTRACT_VIOLATION" ? 1 : allowIncomplete ? 0 : 3);

async function main(argv: string[]): Promise<void> {
  const [group, sub, ...rest] = argv;
  if (group === "env-fingerprint") {
    const key = sub;
    if (!key) return fail(2, USAGE);
    console.log(environmentFingerprint(key));
    return;
  }
  if (group !== "contract" || !sub || !["validate", "register", "check", "report", "surface-keys"].includes(sub)) return fail(2, USAGE);
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({ args: rest, options: { file: { type: "string" }, contract: { type: "string" }, version: { type: "string" }, json: { type: "boolean", default: false }, "allow-incomplete": { type: "boolean", default: false } }, strict: true }).values;
  } catch (e) { return fail(2, `${(e as Error).message}\n\n${USAGE}`); }
  const o: Out = { json: values.json === true };
  const version = values.version === undefined ? "" : `?version=${encodeURIComponent(String(values.version))}`;

  if (sub === "validate" || sub === "register") {
    if (typeof values.file !== "string") return fail(2, "--file is required", o);
    const text = readManifest(values.file, o) as string;
    const parsed = parseManifestText(text);
    const r = parsed.ok ? parseContract(parsed.value) : { ok: false as const, issues: [parsed.issue] };
    if (!r.ok) {
      print(o, `INVALID ${values.file}\n${r.issues.map(fmtIssue).join("\n")}`, { valid: false, file: values.file, issues: r.issues });
      process.exit(1);
    }
    if (sub === "validate") {
      print(o, `VALID ${values.file}\n${describeContract(r.contract)}${r.warnings.length ? `\nWarnings:\n${r.warnings.map(fmtIssue).join("\n")}` : ""}`, { valid: true, file: values.file, contract: r.contract, warnings: r.warnings });
      return;
    }
    const res = await api("POST", "/api/contracts", parsed.ok ? parsed.value : undefined, o);
    if (res.status !== 200) return fail(1, `${res.json?.error?.code ?? res.status}: ${res.json?.error?.message ?? "registration failed"}`, o);
    print(o, `${res.json.status === "created" ? "Registered" : "Already registered (unchanged)"} ${r.contract.id} v${r.contract.version}; ${res.json.drift.length} change(s) vs the previous version`, res.json);
    return;
  }

  if (typeof values.contract !== "string") return fail(2, "--contract is required", o);
  const id = encodeURIComponent(values.contract);
  if (sub === "surface-keys") {
    const r = await api("GET", `/api/contracts/${id}/surface-keys${version}`, undefined, o);
    if (r.status !== 200) return fail(r.status === 404 ? 2 : 1, `${r.json?.error?.code ?? r.status}: ${r.json?.error?.message ?? "request failed"}`, o);
    const map = Object.fromEntries((r.json.keys as { surfaceId: string; key: string }[]).map((k) => [k.surfaceId, k.key]));
    print(o, `# Secrets. Give each surface only its own key. SURFACE_KEYS='${JSON.stringify(map)}'`, { contractId: r.json.contractId, version: r.json.version, keys: map });
    return;
  }
  const res = sub === "check" ? await api("POST", `/api/contracts/${id}/check${version}`, undefined, o) : await api("GET", `/api/contracts/${id}/report${version}`, undefined, o);
  if (res.status !== 200) return fail(res.status === 404 ? 2 : 1, `${res.json?.error?.code ?? res.status}: ${res.json?.error?.message ?? "request failed"}`, o);
  print(o, describeReport(res.json), res.json);
  process.exit(exitForStatus(res.json.report.status, values["allow-incomplete"] === true));
}

main(process.argv.slice(2)).catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); });
