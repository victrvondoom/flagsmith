import type { Route } from "./app.ts";
import { HttpError } from "./http.ts";
import { buildReport, checkContract, getContractVersion, ingestObservations, issueIdentity, listContracts, listDrift, listFindings, registerContract, validateManifest, verifyIdentity } from "./contracts.ts";
import { CONTRACT_SCENARIOS, EXAMPLE_MANIFEST, runContractScenario } from "./contract-sim.ts";
import { readFileSync } from "node:fs";

const optVersion = (q: URLSearchParams): number | undefined => {
  const v = q.get("version");
  if (v === null) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "validation_failed", "version must be a positive integer");
  return n;
};
const obj = (b: unknown): Record<string, unknown> => { if (typeof b !== "object" || b === null || Array.isArray(b)) throw new HttpError(400, "invalid_body", "Body must be a JSON object"); return b as Record<string, unknown>; };
const ID = "([a-z0-9][a-z0-9_-]{0,63})";

export const contractRoutes: Route[] = [
  { method: "POST", pattern: /^\/api\/contracts\/validate$/, auth: "admin", handler: async ({ body }) => { const v = validateManifest(await body()); return { valid: v.valid, issues: v.issues, contract: v.contract }; } },
  { method: "POST", pattern: /^\/api\/contracts$/, auth: "admin", handler: async ({ ctx, body, actor }) => { const r = registerContract(ctx, await body(), actor); return { status: r.status, contract: r.stored.contract, drift: r.drift, warnings: r.warnings }; } },
  { method: "GET", pattern: /^\/api\/contracts$/, auth: "admin", handler: ({ ctx }) => ({ contracts: listContracts(ctx) }) },
  { method: "GET", pattern: new RegExp(`^/api/contracts/${ID}$`), auth: "admin", handler: ({ ctx, params }) => { const s = getContractVersion(ctx, params[0]!); return { contract: s.contract, isSimulation: s.isSimulation, createdAt: s.createdAt, createdBy: s.createdBy, versions: listContracts(ctx).find((c) => c.id === params[0])?.versions ?? [] }; } },
  { method: "GET", pattern: new RegExp(`^/api/contracts/${ID}/versions/(\\d+)$`), auth: "admin", handler: ({ ctx, params }) => { const s = getContractVersion(ctx, params[0]!, Number(params[1])); return { contract: s.contract, isSimulation: s.isSimulation, createdAt: s.createdAt, createdBy: s.createdBy, manifestHash: s.manifestHash }; } },
  { method: "GET", pattern: new RegExp(`^/api/contracts/${ID}/report$`), auth: "admin", handler: ({ ctx, params, query }) => buildReport(ctx, params[0]!, optVersion(query)) },
  { method: "POST", pattern: new RegExp(`^/api/contracts/${ID}/check$`), auth: "admin", handler: ({ ctx, params, query }) => checkContract(ctx, params[0]!, optVersion(query)) },
  { method: "GET", pattern: new RegExp(`^/api/contracts/${ID}/findings$`), auth: "admin", handler: ({ ctx, params, query }) => { getContractVersion(ctx, params[0]!); return { findings: listFindings(ctx, params[0]!, { ...(optVersion(query) !== undefined ? { version: optVersion(query)! } : {}), ...(query.get("code") ? { code: query.get("code")! } : {}) }) }; } },
  { method: "GET", pattern: new RegExp(`^/api/contracts/${ID}/drift$`), auth: "admin", handler: ({ ctx, params }) => { getContractVersion(ctx, params[0]!); return { drift: listDrift(ctx, params[0]!, 200) }; } },
  { method: "POST", pattern: /^\/api\/contract-observations$/, auth: "ingest", handler: async ({ ctx, body }) => ingestObservations(ctx, obj(await body()).observations) },
  { method: "POST", pattern: /^\/api\/identity\/issue$/, auth: "issuer", handler: async ({ ctx, body }) => issueIdentity(ctx, await body()) },
  { method: "POST", pattern: /^\/api\/identity\/verify$/, auth: "ingest", handler: async ({ ctx, body }) => verifyIdentity(ctx, obj(await body()).token) },
  { method: "GET", pattern: /^\/api\/contract-example$/, auth: "admin", handler: () => ({ yaml: readFileSync(EXAMPLE_MANIFEST, "utf8") }) },
  { method: "GET", pattern: /^\/api\/contract-scenarios$/, auth: "admin", handler: ({ ctx }) => ({ enabled: ctx.cfg.demoMode, label: "SIMULATION: synthetic subjects and surfaces; never mixed with real contracts", scenarios: CONTRACT_SCENARIOS }) },
  { method: "POST", pattern: /^\/api\/simulate\/contract\/([a-z-]+)$/, auth: "admin", handler: ({ ctx, params }) => { if (!ctx.cfg.demoMode) throw new HttpError(403, "demo_disabled", "Simulation is disabled (VARIANTSHIELD_DEMO_MODE=false)"); return runContractScenario(ctx, params[0]!); } },
];
