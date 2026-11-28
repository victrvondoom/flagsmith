/**
 * Live incident demo against a REAL Flagsmith. Nothing here is simulated except the shoppers' behaviour.
 *
 *  1. Creates (or reuses) six flags in the Flagsmith project and resets them.
 *  2. Registers a signed environment webhook to VariantShield (FLAG_UPDATED -> Archivist), if --webhook is given.
 *  3. Sends 15 minutes of backdated healthy traffic, then changes six flags as an operator would (Flagsmith's own API).
 *  4. Live traffic: every request asks Flagsmith's SDK endpoint which flags this identity gets (so the swarm's canary
 *     segment overrides are evaluated by Flagsmith itself), fails or succeeds according to a hidden culprit, and is
 *     reported to VariantShield with the flags it was served.
 *  5. Optionally approves the envelope as one person and the remediation as two people, then waits for RESOLVED.
 *
 * Usage:
 *   FLAGSMITH_URL=... FLAGSMITH_ENVIRONMENT_KEY=... FLAGSMITH_ADMIN_TOKEN=...  (or FLAGSMITH_ADMIN_API_KEY)
 *   VARIANTSHIELD_URL=http://127.0.0.1:8787 VARIANTSHIELD_INGEST_KEY=... VARIANTSHIELD_ADMIN_TOKEN=...
 *   node scripts/storefront.ts [--culprit new_tax_engine | --culprit fast_checkout+new_tax_engine] [--rps 60] [--auto] [--webhook <secret>]
 */
import { setTimeout as sleep } from "node:timers/promises";
import { mulberry32 } from "../packages/bisect/src/simulate.ts";

const env = (k: string): string => { const v = process.env[k]; if (!v) { console.error(`${k} is required`); process.exit(2); } return v; };
const arg = (name: string, d?: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? (process.argv[i + 1] ?? "") : d; };
const FS = env("FLAGSMITH_URL").replace(/\/+$/, ""), ENV_KEY = env("FLAGSMITH_ENVIRONMENT_KEY");
const ADMIN = process.env.FLAGSMITH_ADMIN_API_KEY ? `Api-Key ${process.env.FLAGSMITH_ADMIN_API_KEY}` : `Token ${env("FLAGSMITH_ADMIN_TOKEN")}`;
const VS = env("VARIANTSHIELD_URL").replace(/\/+$/, ""), INGEST = env("VARIANTSHIELD_INGEST_KEY"), VS_ADMIN = process.env.VARIANTSHIELD_ADMIN_TOKEN ?? "";
const culprit = (arg("culprit", "new_tax_engine") ?? "new_tax_engine").split("+");
const RPS = Number(arg("rps", "60"));
const AUTO = process.argv.includes("--auto");
const HOOK = arg("webhook");
const rnd = mulberry32(2026);

type V = { enabled: boolean; value: string | null };
const FLAGS: { name: string; before: V; after: V }[] = [
  { name: "address_autocomplete", before: { enabled: false, value: null }, after: { enabled: true, value: null } },
  { name: "promo_banner", before: { enabled: true, value: "diwali" }, after: { enabled: true, value: "black_friday" } },
  { name: "search_reranker", before: { enabled: true, value: "bm25" }, after: { enabled: true, value: "hybrid_v2" } },
  { name: "fast_checkout", before: { enabled: false, value: null }, after: { enabled: true, value: null } },
  { name: "new_tax_engine", before: { enabled: false, value: null }, after: { enabled: true, value: null } },
  { name: "dark_mode_default", before: { enabled: false, value: null }, after: { enabled: true, value: null } },
];

async function fs(method: string, path: string, body?: unknown, sdk = false): Promise<any> {
  const res = await fetch(FS + path, { method, headers: { "content-type": "application/json", ...(sdk ? { "x-environment-key": ENV_KEY } : { authorization: ADMIN }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Flagsmith ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
async function vs(method: string, path: string, body: unknown, headers: Record<string, string>): Promise<any> {
  const res = await fetch(VS + path, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`VariantShield ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const as = (actor: string): Record<string, string> => ({ authorization: `Bearer ${VS_ADMIN}`, "x-variantshield-actor": actor });
const typed = (v: string | null): unknown => (v === null ? null : { type: "string", value: v });
const log = (m: string): void => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`);

const envInfo = await fs("GET", `/api/v1/environments/${ENV_KEY}/`);
const project = envInfo.project as number;
log(`Flagsmith ${FS}: environment "${envInfo.name}" (#${envInfo.id}), project ${project}, v2 versioning ${envInfo.use_v2_feature_versioning === true}`);
const ids = new Map<string, number>();
for (const f of FLAGS) {
  const found = (await fs("GET", `/api/v1/projects/${project}/features/?search=${f.name}&page_size=100`)).results.find((x: any) => x.name === f.name);
  const id = found ? found.id : (await fs("POST", `/api/v1/projects/${project}/features/`, { name: f.name, default_enabled: f.before.enabled, initial_value: f.before.value ?? "", description: "VariantShield incident demo flag" })).id;
  ids.set(f.name, id);
  // Reset to `before` and remove leftover overrides from earlier runs.
  const state = await fs("GET", `/api/__future__/environments/${ENV_KEY}/features/${id}/`);
  for (const o of state.segment_overrides ?? []) await fs("DELETE", `/api/__future__/environments/${ENV_KEY}/features/${id}/segment-overrides/${o.segment.id}/`);
  await fs("PATCH", `/api/__future__/environments/${ENV_KEY}/features/${id}/`, { environment_default: { enabled: f.before.enabled, value: typed(f.before.value) } });
}
for (const s of (await fs("GET", `/api/v1/projects/${project}/segments/?page_size=100`)).results ?? []) if (/^vs-canary-/.test(s.name)) await fs("DELETE", `/api/v1/projects/${project}/segments/${s.id}/`);
await sleep(12_000); // let VariantShield's flag watcher see the reset state before the deploy
log(`Flags ready: ${[...ids].map(([n, i]) => `${n}#${i}`).join(", ")}. Hidden culprit: ${culprit.join(" + ")}.`);

if (HOOK) {
  const hooks = await fs("GET", `/api/v1/environments/${ENV_KEY}/webhooks/`);
  const url = `${VS}/api/flagsmith/webhook`;
  for (const w of (Array.isArray(hooks) ? hooks : hooks.results ?? []).filter((w: any) => w.url === url)) await fs("DELETE", `/api/v1/environments/${ENV_KEY}/webhooks/${w.id}/`);
  try {
    await fs("POST", `/api/v1/environments/${ENV_KEY}/webhooks/`, { url, enabled: true, secret: HOOK });
    log(`Registered a signed Flagsmith webhook to ${url}`);
  } catch (e) {
    // Flagsmith refuses webhook URLs on private networks (SSRF protection). The Archivist then reads the audit log instead.
    log(`Flagsmith refused the webhook (${String(e).slice(0, 160)}). Continuing with the audit-log fallback.`);
  }
}

const served = async (identity: string): Promise<Record<string, V>> => {
  const r = await fs("GET", `/api/v1/identities/?identifier=${encodeURIComponent(identity)}`, undefined, true);
  const out: Record<string, V> = {};
  for (const f of r.flags) if (ids.has(f.feature.name)) out[f.feature.name] = { enabled: f.enabled === true, value: f.feature_state_value === "" ? null : f.feature_state_value ?? null };
  return out;
};
const broken = (flags: Record<string, V>): boolean => culprit.every((c) => { const f = FLAGS.find((x) => x.name === c)!; return flags[c]?.enabled === f.after.enabled && String(flags[c]?.value ?? "") === String(f.after.value ?? ""); });

// 1. Backdated healthy history (flags as they were before the deploy).
{
  const flags = await served("history-probe");
  const signals = [];
  const now = Date.now();
  for (let i = 0; i < 6000; i++) signals.push({ ts: now - 15 * 60_000 + Math.floor((i / 6000) * 15 * 60_000), identity: `shopper-${Math.floor(rnd() * 8000)}`, ok: rnd() >= 0.01, flags });
  for (let i = 0; i < signals.length; i += 1000) await vs("POST", "/api/bisect/signals", { signals: signals.slice(i, i + 1000) }, { "x-ingest-key": INGEST });
  log("Sent 15 minutes of healthy history (6,000 requests, 1% baseline failures).");
}

// 2. The deploy: six changes through Flagsmith's own API, a few seconds apart.
for (const f of FLAGS) {
  await fs("PATCH", `/api/__future__/environments/${ENV_KEY}/features/${ids.get(f.name)}/`, { environment_default: { enabled: f.after.enabled, value: typed(f.after.value) } });
  log(`Changed ${f.name}: ${JSON.stringify(f.before)} -> ${JSON.stringify(f.after)}`);
  await sleep(1500);
}

// 3. Live traffic, plus optional human steps.
let sent = 0, failed = 0, stop = false;
const stats = { lastIncident: 0, state: "" };
const worker = async (): Promise<void> => {
  const batch: unknown[] = [];
  let lastFlush = Date.now();
  while (!stop) {
    const identity = `shopper-${Math.floor(rnd() * 8000)}`;
    const t0 = Date.now();
    const flags = await served(identity);
    const ok = rnd() >= (broken(flags) ? 0.09 : 0.01);
    batch.push({ ts: Date.now(), identity, ok, flags });
    sent++; if (!ok) failed++;
    if (batch.length >= 50 || Date.now() - lastFlush > 2000) { await vs("POST", "/api/bisect/signals", { signals: batch.splice(0) }, { "x-ingest-key": INGEST }); lastFlush = Date.now(); }
    const wait = 1000 / (RPS / 8) - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
  }
};
const workers = Array.from({ length: 8 }, () => worker());
const started = Date.now();
while (Date.now() - started < 45 * 60_000) {
  await sleep(5000);
  if (!VS_ADMIN) { log(`traffic: ${sent} requests, ${failed} failures`); continue; }
  const list = (await (await fetch(`${VS}/api/incidents?source=real`, { headers: as("observer") })).json()).incidents as any[];
  const inc = list[0];
  if (!inc) { log(`traffic: ${sent} requests, ${(100 * failed / Math.max(1, sent)).toFixed(2)}% failed; no incident yet`); continue; }
  if (inc.state !== stats.state) { log(`incident #${inc.id}: ${inc.state}${inc.conclusion ? ` (${inc.conclusion.key}, ${(inc.conclusion.confidence * 100).toFixed(1)}%)` : ""}, rounds ${inc.rounds}`); stats.state = inc.state; }
  if (!AUTO) continue;
  if (inc.state === "AWAITING_APPROVAL") await vs("POST", `/api/incidents/${inc.id}/envelope`, { confirmation: `BISECT ${inc.id}`, reason: "Live demo: approve a 10% canary", canaryPercent: 10 }, as("alice"));
  if (inc.state === "IDENTIFIED") await vs("POST", `/api/incidents/${inc.id}/remediation`, { action: "propose", reason: "Restore the confirmed culprit for everyone" }, as("alice"));
  if (inc.state === "REMEDIATION_PROPOSED") await vs("POST", `/api/incidents/${inc.id}/remediation`, { action: "approve", confirmation: `REMEDIATE ${inc.id}`, reason: "Reviewed the confirmation probe" }, as("bob"));
  if (["RESOLVED", "NOT_A_FLAG_CHANGE", "INCONCLUSIVE", "ABORTED"].includes(inc.state)) break;
}
stop = true;
await Promise.all(workers);
const final = {} as Record<string, V>;
for (const f of FLAGS) { const s = await fs("GET", `/api/__future__/environments/${ENV_KEY}/features/${ids.get(f.name)}/`); final[f.name] = { enabled: s.environment_default.enabled, value: s.environment_default.value?.value ?? null }; }
log(`Done: ${sent} live requests. Flagsmith now serves: ${JSON.stringify(final)}`);
const segs = ((await fs("GET", `/api/v1/projects/${project}/segments/?page_size=100`)).results ?? []).filter((s: any) => /^vs-canary-/.test(s.name));
log(`Canary segments left in Flagsmith: ${segs.length}`);
