import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { resolve } from "node:path";
import { FlagsmithClient, FlagsmithError } from "../../../packages/flagsmith-adapter/src/index.ts";
import { renderCheckout } from "./pages.ts";
import { FAULT_DEFAULTS, FAULT_TYPES, FaultController, type FaultType } from "./faults.ts";
import type { Assignment, Telemetry } from "./instrument.ts";

export interface DemoConfig {
  featureKey: string;
  latencyScale: number;
  /** Trusts ?variant=… for local UI testing. Telemetry is suppressed for overridden sessions. */
  allowOverride: boolean;
  /** Trusts the x-demo-uid header so a traffic generator can act as many distinct users. */
  allowUidHeader: boolean;
  controlKey: string;
  /** How long the page waits for a payment response before offering a retry. */
  clientTimeoutMs?: number;
  random?: () => number;
  now?: () => number;
}

interface Attempt { key: string; at: number; outcome: { status: number; body: Record<string, unknown> } }
const BASE_LATENCY: Record<string, number> = { control: 700, upi_first: 600, one_tap: 450 };
const UID_RE = /^[A-Za-z0-9_-]{3,64}$/;
const PUBLIC = resolve(import.meta.dirname, "../public");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const same = (a: string | undefined, b: string): boolean => a !== undefined && timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

export interface DemoApp { server: Server; faults: FaultController }

const LOOPBACK = /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/;

/** True when cookies must carry `Secure`: the request is HTTPS, or it does not come from this machine. */
export function isSecureContext(req: Pick<IncomingMessage, "headers" | "socket">): boolean {
  const proto = req.headers["x-forwarded-proto"];
  if (typeof proto === "string" && proto.split(",")[0]!.trim() === "https") return true;
  return !LOOPBACK.test(req.socket.remoteAddress ?? "");
}

export function createDemoApp(opts: { flagsmith: FlagsmithClient | null; telemetry: Telemetry; cfg: DemoConfig; onError?: (e: unknown) => void }): DemoApp {
  const { cfg, telemetry, flagsmith } = opts;
  const rand = cfg.random ?? Math.random;
  const now = cfg.now ?? Date.now;
  const faults = new FaultController();
  const assignments = new Map<string, { a: Assignment; at: number }>();
  const attempts = new Map<string, Attempt>();

  const overrideFrom = (req: IncomingMessage): string | null => (cfg.allowOverride ? (/(?:^|;\s*)vs_override=([\w-]{1,64})/.exec(req.headers.cookie ?? "")?.[1] ?? null) : null);

  async function assign(uid: string, override: string | null): Promise<{ a: Assignment; banner: string | null }> {
    if (override && cfg.allowOverride) return { a: { variantKey: override, source: "override" }, banner: `Local preview: variant "${override}" forced. No telemetry is recorded.` };
    if (!flagsmith) return { a: { variantKey: null, source: "unassigned" }, banner: "Flagsmith is not configured, so this session has no experiment assignment." };
    const hit = assignments.get(uid);
    if (hit && now() - hit.at < 60_000) return { a: hit.a, banner: null };
    try {
      const r = await flagsmith.getIdentityAssignment(uid, cfg.featureKey);
      if (r.variantKey === null) return { a: { variantKey: null, source: "unassigned" }, banner: `Flagsmith returned no variant for "${cfg.featureKey}" (${r.reason}).` };
      const a: Assignment = { variantKey: r.variantKey, source: "flagsmith" };
      assignments.set(uid, { a, at: now() });
      void flagsmith.sendExposure(uid, cfg.featureKey, r.variantKey).catch((e) => opts.onError?.(e));
      return { a, banner: null };
    } catch (e) {
      opts.onError?.(e);
      return { a: { variantKey: null, source: "unassigned" }, banner: `Could not reach Flagsmith (${e instanceof FlagsmithError ? e.kind : "error"}); no experiment assignment.` };
    }
  }

  /**
   * Sets a demo cookie. `Secure` is included whenever the connection is HTTPS (signalled by a trusted proxy) or the client is not
   * on this machine. The one exception is a client on loopback over plain HTTP, i.e. someone running the demo locally:
   * Chromium and Firefox keep a Secure cookie there, WebKit/Safari does not, and a dropped cookie makes the demo hand every
   * request a new identity and therefore a new variant (CI confirmed this in WebKit). A remote client never gets a cookie
   * without `Secure`. The value is a random demo visitor id, not a credential. Both branches spell out their flags literally.
   */
  function setDemoCookie(req: IncomingMessage, res: ServerResponse, name: string, value: string, maxAgeSeconds?: number): void {
    const age = maxAgeSeconds === undefined ? "" : `; Max-Age=${maxAgeSeconds}`;
    const cookie = isSecureContext(req)
      ? `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax${age}`
      : `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${age}`;
    res.setHeader("set-cookie", [...[res.getHeader("set-cookie") ?? []].flat().map(String), cookie]);
  }

  function identify(req: IncomingMessage, res: ServerResponse): string {
    const header = req.headers["x-demo-uid"];
    if (cfg.allowUidHeader && typeof header === "string" && UID_RE.test(header)) return header;
    const cookie = /(?:^|;\s*)vs_uid=([\w-]{3,64})/.exec(req.headers.cookie ?? "")?.[1];
    if (cookie) return cookie;
    const uid = randomUUID().replace(/-/g, "");
    setDemoCookie(req, res, "vs_uid", uid, 86400);
    return uid;
  }

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) { n += (c as Buffer).length; if (n > 16_384) throw new RangeError("body too large"); chunks.push(c as Buffer); }
    try { const v = JSON.parse(Buffer.concat(chunks).toString() || "{}"); return typeof v === "object" && v !== null ? v : {}; } catch { return {}; }
  };

  async function pay(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const uid = identify(req, res);
    const body = await readBody(req);
    const key = typeof body.idempotencyKey === "string" && body.idempotencyKey.length <= 100 ? body.idempotencyKey : randomUUID();
    const { a } = await assign(uid, overrideFrom(req));
    const requestId = randomUUID();
    const variant = a.variantKey;
    const fault = faults.forVariant(variant);
    const emit = (type: Parameters<Telemetry["emit"]>[0]["type"], outcome: "success" | "failure" | "rejected", extra: { latencyMs?: number; httpStatus?: number; errorCategory?: string } = {}): void =>
      telemetry.emit({ type, uid, assignment: a, requestId, operation: `checkout.${type}`, outcome, ...extra });

    emit("checkout_started", "success");

    // Duplicate handling: same key replays the first result (no second charge); a fresh key inside the window is a double submit.
    const prior = attempts.get(uid);
    if (prior && now() - prior.at < 5000) {
      if (prior.key === key) {
        emit("duplicate_submit", "rejected", { httpStatus: prior.outcome.status });
        return json(res, prior.outcome.status, { ...prior.outcome.body, replay: true });
      }
      emit("duplicate_submit", "failure", { errorCategory: "double_charge_attempt" });
    }

    let status = 200;
    let result: Record<string, unknown>;
    const base = (BASE_LATENCY[variant ?? "control"] ?? 700) * cfg.latencyScale;
    await sleep(base * (0.6 + 0.8 * rand()) + (fault.type === "slow_responses" ? 1600 * cfg.latencyScale : 0));
    if (fault.type === "server_errors" && rand() < fault.rate) {
      status = 503; result = { status: "error" };
      emit("http_request", "failure", { httpStatus: 503, errorCategory: "server_error" });
    } else if (fault.type === "payment_failures" && rand() < fault.rate) {
      status = 200; result = { status: "declined" };
      emit("http_request", "success", { httpStatus: 200 });
      emit("payment_failed", "failure", { errorCategory: "payment_declined" });
    } else {
      result = { status: "ok", orderId: `ORD-${randomUUID().slice(0, 8).toUpperCase()}` };
      emit("http_request", "success", { httpStatus: 200 });
      emit("checkout_completed", "success");
      if (flagsmith && a.source === "flagsmith") void flagsmith.sendEvents([{ event: "checkout_completed", identifier: uid, timestampMs: now(), value: 1 }]).catch((e) => opts.onError?.(e));
    }
    emit("checkout_latency", status >= 500 ? "failure" : "success", { latencyMs: performance.now() - started });
    attempts.set(uid, { key, at: now(), outcome: { status, body: result } });
    if (attempts.size > 5000) attempts.delete(attempts.keys().next().value as string);
    json(res, status, result);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/health") return json(res, 200, { status: "ok" });
      if (url.pathname === "/__fault") {
        if (!same(req.headers["x-demo-key"] as string | undefined, cfg.controlKey)) return json(res, 401, { error: "invalid demo control key" });
        if (req.method === "GET") return json(res, 200, faults.get());
        if (req.method === "DELETE") { faults.clear(); return json(res, 200, faults.get()); }
        if (req.method === "POST") {
          const b = await readBody(req);
          const type = b.type as FaultType;
          if (!FAULT_TYPES.includes(type) || type === "none" || typeof b.variant !== "string" || !/^[\w.-]{1,64}$/.test(b.variant)) return json(res, 400, { error: `type must be one of ${FAULT_TYPES.filter((t) => t !== "none").join(", ")} and variant is required` });
          const rate = typeof b.rate === "number" && b.rate >= 0 && b.rate <= 1 ? b.rate : FAULT_DEFAULTS[type];
          faults.set({ variant: b.variant, type, rate });
          return json(res, 200, faults.get());
        }
      }
      if (req.method === "GET" && url.pathname === "/") {
        const uid = identify(req, res);
        const override = cfg.allowOverride ? url.searchParams.get("variant") : null;
        if (override && /^[\w-]{1,64}$/.test(override)) setDemoCookie(req, res, "vs_override", override);
        const { a, banner } = await assign(uid, override);
        const variant = a.variantKey ?? "control";
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return void res.end(renderCheckout(variant, banner, faults.forVariant(a.variantKey).type === "duplicate_submissions", cfg.clientTimeoutMs ?? 8000));
      }
      if (req.method === "POST" && url.pathname === "/api/pay") return await pay(req, res);
      if (req.method === "GET" && (url.pathname === "/checkout.css" || url.pathname === "/checkout.js")) {
        res.writeHead(200, { "content-type": url.pathname.endsWith(".css") ? "text/css" : "text/javascript", "cache-control": "no-cache" });
        return void createReadStream(resolve(PUBLIC, url.pathname.slice(1))).pipe(res);
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      opts.onError?.(e);
      if (!res.headersSent) json(res, e instanceof RangeError ? 413 : 500, { error: "internal" });
    }
  });
  return { server, faults };
}
