import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { FlagsmithClient } from "../../../packages/flagsmith-adapter/src/index.ts";
import { environmentFingerprint, type FeatureValue } from "../../../packages/contracts/src/index.ts";

/**
 * One application surface taking part in a cross-surface experiment contract.
 * Per request it: (1) asks VariantShield to verify the identity token (it never holds the signing secret and never trusts a bare id),
 * (2) asks FLAGSMITH which variant that canonical subject gets (no local bucketing), (3) resolves ITS OWN feature values from that
 * variant, (4) reports the observation. The feature mapping is what this surface's code actually implements; a faulty deploy is
 * simulated with /__config overrides.
 */
export interface SurfaceDef {
  id: string;
  domain: string;
  /** What this surface implements for each variant: the values it will resolve. */
  implementation: Record<string, Record<string, FeatureValue>>;
}

export interface SurfaceConfig {
  def: SurfaceDef;
  flagsmith: FlagsmithClient;
  /** Flagsmith client-side environment key, used only to derive the non-secret fingerprint reported with each observation. */
  environmentKey: string;
  environmentName: string;
  variantshieldUrl: string;
  /** Per-surface reporting key (bound to this contract and surface). The master ingest key must never be given to a surface. */
  surfaceKey: string;
  contractId: string;
  contractVersion: number;
  experimentKey: string;
  assignmentFlag: string;
  controlKey: string;
  now?: () => number;
}

export interface SurfaceFaults {
  /** Replace resolved feature values (a surface deployed with the wrong route/policy). */
  featureOverrides: Record<string, FeatureValue>;
  /** Report a different variant than Flagsmith returned (stale cache, own bucketing). */
  reportVariant: string | null;
  /** Report this environment name instead of the real one (a surface pointed at the wrong environment). */
  environmentName: string | null;
  /** Stop attaching the verified token (breaks identity propagation). */
  dropIdentity: boolean;
}

const same = (a: string | undefined, b: string): boolean => a !== undefined && timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

export function createSurface(cfg: SurfaceConfig): { server: Server; faults: () => SurfaceFaults } {
  const now = cfg.now ?? Date.now;
  let faults: SurfaceFaults = { featureOverrides: {}, reportVariant: null, environmentName: null, dropIdentity: false };
  const fingerprint = environmentFingerprint(cfg.environmentKey);

  const json = (res: ServerResponse, status: number, body: unknown): void => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = []; let n = 0;
    for await (const c of req) { n += (c as Buffer).length; if (n > 16_384) throw new RangeError("body too large"); chunks.push(c as Buffer); }
    try { const v = JSON.parse(Buffer.concat(chunks).toString() || "{}"); return typeof v === "object" && v !== null && !Array.isArray(v) ? v : {}; } catch { return {}; }
  };
  const vs = async (path: string, body: unknown): Promise<{ status: number; json: any }> => {
    const r = await fetch(`${cfg.variantshieldUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-surface-key": cfg.surfaceKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    return { status: r.status, json: await r.json() };
  };

  async function resolve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const token = typeof body.identityToken === "string" ? body.identityToken : undefined;
    // 1. Identity: verified by VariantShield, never guessed from anything the caller says.
    const verified = token ? (await vs("/api/identity/verify", { token, audience: cfg.contractId })).json : { valid: false, reason: "missing" };
    const subjectRef: string | null = verified.valid ? verified.subjectRef : null;
    // 2. Assignment: from Flagsmith, for the canonical subject, in this surface's environment.
    let variant: string | null = null;
    let assignmentNote: string | null = null;
    if (subjectRef) {
      try { const a = await cfg.flagsmith.getIdentityAssignment(subjectRef, cfg.assignmentFlag); variant = a.variantKey; assignmentNote = a.reason; }
      catch (e) { assignmentNote = `flagsmith_unavailable:${(e as { kind?: string }).kind ?? "error"}`; }
    } else assignmentNote = `identity_${verified.reason ?? "unverified"}`;
    // 3. Resolve this surface's own feature values from the variant (what its code implements, plus any injected fault).
    const reported = faults.reportVariant ?? variant;
    const impl = variant ? cfg.def.implementation[variant] : undefined;
    const features: Record<string, FeatureValue> = { ...(impl ?? {}), ...faults.featureOverrides };
    // 4. Report.
    const obs = {
      observationId: `${cfg.def.id}-${randomUUID()}`, contractId: cfg.contractId, contractVersion: cfg.contractVersion, experimentKey: cfg.experimentKey,
      environment: faults.environmentName ?? cfg.environmentName, envFingerprint: fingerprint, assignmentFlag: cfg.assignmentFlag, assignedVariant: reported, surfaceId: cfg.def.id,
      identityToken: faults.dropIdentity ? undefined : token, observedAt: now(), features,
    };
    const posted = await vs("/api/contract-observations", { observations: [obs] });
    json(res, 200, { surface: cfg.def.id, domain: cfg.def.domain, subjectRef, assignedVariant: reported, flagsmithVariant: variant, assignmentNote, features, environment: obs.environment, reported: posted.json?.results?.[0] ?? posted.json });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/health") return json(res, 200, { status: "ok", surface: cfg.def.id });
      if (url.pathname === "/__config") {
        if (!same(req.headers["x-surface-key"] as string | undefined, cfg.controlKey)) return json(res, 401, { error: "invalid surface control key" });
        if (req.method === "GET") return json(res, 200, faults);
        if (req.method === "DELETE") { faults = { featureOverrides: {}, reportVariant: null, environmentName: null, dropIdentity: false }; return json(res, 200, faults); }
        if (req.method === "PUT") {
          const b = await readBody(req);
          const fo = typeof b.featureOverrides === "object" && b.featureOverrides !== null ? Object.fromEntries(Object.entries(b.featureOverrides as Record<string, unknown>).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))) as Record<string, FeatureValue> : {};
          faults = { featureOverrides: fo, reportVariant: typeof b.reportVariant === "string" ? b.reportVariant : null, environmentName: typeof b.environmentName === "string" ? b.environmentName : null, dropIdentity: b.dropIdentity === true };
          return json(res, 200, faults);
        }
      }
      if (req.method === "POST" && url.pathname === "/resolve") return await resolve(req, res);
      json(res, 404, { error: "not found" });
    } catch (e) {
      if (!res.headersSent) json(res, e instanceof RangeError ? 413 : 502, { error: e instanceof Error ? e.message : "error" });
    }
  });
  return { server, faults: () => faults };
}

/** What each sample surface implements. This matches examples/checkout-journey.contract.yaml. */
export const SURFACES: SurfaceDef[] = [
  { id: "web-checkout", domain: "checkout", implementation: { control: { checkout_ui: "classic" }, upi_first: { checkout_ui: "upi_first" } } },
  { id: "mobile-checkout", domain: "checkout", implementation: { control: { checkout_ui: "classic" }, upi_first: { checkout_ui: "upi_first" } } },
  { id: "payment-api", domain: "payments", implementation: { control: { payment_route: "legacy" }, upi_first: { payment_route: "upi_intent_v2" } } },
  { id: "risk-engine", domain: "risk", implementation: { control: { retry_policy: "standard" }, upi_first: { retry_policy: "bounded" } } },
];
