import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { environmentFingerprint } from "../packages/contracts/src/index.ts";

/**
 * Drives the cross-surface contract demo against a RUNNING stack: VariantShield API, the four sample surfaces
 * (apps/surfaces) and a real Flagsmith. Subjects get their variant from Flagsmith; nothing here buckets or simulates.
 * Phases: A healthy deployment, B wrong payment route + retry policy on two surfaces, C a surface reporting a stale variant.
 * Exits 1 if VariantShield does not report what each phase should produce, so it doubles as a self-test.
 */
const { values } = parseArgs({ options: { customers: { type: "string", default: "12" }, version: { type: "string", default: "1" }, tag: { type: "string", default: `${Date.now()}` } } });
const env = process.env;
for (const k of ["VARIANTSHIELD_ADMIN_TOKEN", "VARIANTSHIELD_IDENTITY_ISSUER_KEY", "SURFACE_CONTROL_KEY", "FLAGSMITH_ENVIRONMENT_KEY"]) if (!env[k]) { console.error(`Set ${k}`); process.exit(2); }
const API = env.VARIANTSHIELD_URL ?? "http://127.0.0.1:8787";
const basePort = Number(env.SURFACES_BASE_PORT ?? 8801);
const SURFACE_IDS = ["web-checkout", "mobile-checkout", "payment-api", "risk-engine"];
const N = Number(values.customers);
const admin = async (method: string, path: string, body?: unknown): Promise<any> => {
  const r = await fetch(API + path, { method, headers: { authorization: `Bearer ${env.VARIANTSHIELD_ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const surfaceUrl = (i: number): string => `http://127.0.0.1:${basePort + i}`;
const fault = (i: number, body: unknown | null): Promise<Response> => fetch(`${surfaceUrl(i)}/__config`, { method: body ? "PUT" : "DELETE", headers: { "x-surface-key": env.SURFACE_CONTROL_KEY!, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const say = (s: string): void => console.log(`\n== ${s}`);
let failures = 0;
const expect = (name: string, ok: boolean, detail = ""): void => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`); if (!ok) failures++; };

say("Register the contract (environment pinned to the Flagsmith key in use)");
const manifest = parseYaml(readFileSync(resolve(import.meta.dirname, "../examples/checkout-journey.contract.yaml"), "utf8")) as any;
manifest.contract.version = Number(values.version);
manifest.experiment.environment_fingerprint = environmentFingerprint(env.FLAGSMITH_ENVIRONMENT_KEY!);
if (env.FLAGSMITH_EXPERIMENT_ID) manifest.experiment.flagsmith_experiment_id = Number(env.FLAGSMITH_EXPERIMENT_ID);
const reg = await admin("POST", "/api/contracts", manifest);
console.log(`${reg.status}: ${manifest.contract.id} v${manifest.contract.version}; ${reg.drift.length} change(s) vs the previous version`);

const runCustomers = async (prefix: string): Promise<{ variants: Record<string, number> }> => {
  const variants: Record<string, number> = {};
  for (let i = 0; i < N; i++) {
    const id = await (await fetch(`${API}/api/identity/issue`, { method: "POST", headers: { "x-identity-issuer-key": env.VARIANTSHIELD_IDENTITY_ISSUER_KEY!, "content-type": "application/json" }, body: JSON.stringify({ subject: `${prefix}-${i}` }) })).json() as { token: string };
    const rs = await Promise.all(SURFACE_IDS.map(async (_, s) => (await fetch(`${surfaceUrl(s)}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identityToken: id.token }) })).json() as Promise<{ flagsmithVariant: string }>));
    variants[rs[0]!.flagsmithVariant] = (variants[rs[0]!.flagsmithVariant] ?? 0) + 1;
  }
  return { variants };
};
const check = async (): Promise<any> => admin("POST", `/api/contracts/checkout-journey/check?version=${values.version}`);
const summary = (c: any): void => console.log(`status=${c.report.status} primary=${c.report.primaryCode ?? "-"} | surfaces: ${c.report.surfaces.map((s: any) => `${s.id}=${s.status}`).join(", ")} | Flagsmith re-verified ${c.flagsmith.subjectsChecked} subject(s)${c.flagsmith.configFingerprint ? `, assignment config ${c.flagsmith.configFingerprint}` : ""}`);

say(`Phase A: healthy deployment, ${N} customers resolved by all four surfaces`);
for (let i = 0; i < 4; i++) await fault(i, null);
const a = await runCustomers(`a-${values.tag}`);
console.log(`Flagsmith assigned: ${JSON.stringify(a.variants)}`);
const ca = await check(); summary(ca);
expect("both variants were served by Flagsmith", Object.keys(a.variants).length === 2);
expect("contract is valid", ca.report.status === "CONTRACT_VALID", ca.report.findings.slice(0, 2).map((f: any) => f.code).join(","));
expect("Flagsmith re-verification ran", ca.flagsmith.verified === true);

say("Phase B: payment-api routes through legacy and risk-engine keeps the standard retry policy");
await fault(2, { featureOverrides: { payment_route: "legacy" } }); await fault(3, { featureOverrides: { retry_policy: "standard" } });
await runCustomers(`b-${values.tag}`);
const cb = await check(); summary(cb);
const combo = cb.report.findings.filter((f: any) => f.code === "COMBINATION_VIOLATION");
for (const f of combo.slice(0, 3)) console.log(`  ${f.surfaceId}: expected ${f.expected}, actual ${f.actual}`);
expect("COMBINATION_VIOLATION detected", combo.length > 0);
expect("web checkout stays compliant while payment-api and risk-engine are violating", cb.report.surfaces.find((s: any) => s.id === "web-checkout").status === "compliant" && cb.report.surfaces.find((s: any) => s.id === "payment-api").status === "violating" && cb.report.surfaces.find((s: any) => s.id === "risk-engine").status === "violating");
await fault(2, null); await fault(3, null);

say("Phase C: the mobile checkout keeps reporting a stale variant (a cached assignment)");
await fault(1, { reportVariant: "control" });
await runCustomers(`c-${values.tag}`);
const cc = await check(); summary(cc);
const mism = cc.report.findings.filter((f: any) => f.code === "ASSIGNMENT_MISMATCH" && f.evidence.source === "flagsmith_reverify");
if (mism[0]) console.log(`  ${mism[0].surfaceId}: ${mism[0].message}`);
expect("ASSIGNMENT_MISMATCH against Flagsmith itself", mism.length > 0 && mism.every((f: any) => f.surfaceId === "mobile-checkout"));
await fault(1, null);

say("Evidence kept as history");
const hist = await admin("GET", `/api/contracts/checkout-journey/findings?version=${values.version}`);
console.log(`${hist.findings.length} finding(s) recorded for v${values.version}; codes: ${[...new Set(hist.findings.map((f: any) => f.code))].join(", ")}`);
expect("findings were persisted as history", hist.findings.length > 0);
console.log(failures ? `\n${failures} check(s) failed` : "\nAll contract demo checks passed");
process.exit(failures ? 1 : 0);
