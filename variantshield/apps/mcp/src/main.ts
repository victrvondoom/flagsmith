import { createInterface } from "node:readline";
import { createMcpHandler, type Api } from "./server.ts";

/**
 * Starts the VariantShield MCP server on stdio.
 *   VARIANTSHIELD_URL                  default http://127.0.0.1:8787
 *   VARIANTSHIELD_MCP_TOKEN            the viewer (read-only) or admin token. Prefer the viewer token.
 *   VARIANTSHIELD_MCP_ALLOW_PROPOSE    "true" exposes propose_decision (needs an admin token)
 *   VARIANTSHIELD_MCP_ACTOR            name recorded for proposals (default "mcp-assistant")
 * stdout carries protocol messages only; diagnostics go to stderr.
 */
const env = process.env;
const token = env.VARIANTSHIELD_MCP_TOKEN;
if (!token) { console.error("Set VARIANTSHIELD_MCP_TOKEN (a viewer token is enough for the read-only tools)."); process.exit(2); }
const base = (env.VARIANTSHIELD_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const actor = /^[\w .-]{1,40}$/.test(env.VARIANTSHIELD_MCP_ACTOR ?? "") ? env.VARIANTSHIELD_MCP_ACTOR! : "mcp-assistant";

const api: Api = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-variantshield-actor": actor }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const t = await res.text();
  let json: unknown = null;
  try { json = t ? JSON.parse(t) : null; } catch { json = { error: { code: "bad_response", message: "VariantShield returned a non-JSON response" } }; }
  return { status: res.status, json };
};

const handle = createMcpHandler({ api, allowPropose: env.VARIANTSHIELD_MCP_ALLOW_PROPOSE === "true", actor, version: "0.1.0" });
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const MAX_LINE = 1_048_576;
let pending = 0;
rl.on("line", (line) => {
  if (!line.trim()) return;
  const send = (m: unknown): void => { process.stdout.write(`${JSON.stringify(m)}\n`); };
  if (line.length > MAX_LINE) { send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Message too large" } }); return; }
  let msg: unknown;
  try { msg = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
  pending++;
  handle(msg).then((r) => { if (r) send(r); }).catch((e) => { console.error("mcp handler error", e); send({ jsonrpc: "2.0", id: (msg as { id?: unknown })?.id ?? null, error: { code: -32603, message: "Internal error" } }); }).finally(() => { pending--; });
});
rl.on("close", () => { const t = setInterval(() => { if (pending === 0) { clearInterval(t); process.exit(0); } }, 20); });
