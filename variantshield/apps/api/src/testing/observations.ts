import { deriveSurfaceKey } from "../surface-keys.ts";

/**
 * Test helper: posts a mixed batch of observations the way real surfaces do, one request per (contract, surface), each with
 * that surface's own key. Results are merged and `index` is mapped back to the position in the original batch.
 */
export async function postAsSurfaces(base: string, ingestKey: string, body: unknown): Promise<{ status: number; json: any }> {
  const obs = (body as { observations?: unknown } | null)?.observations;
  const slug = /^[a-z0-9][a-z0-9_-]{0,63}$/;
  const usable = Array.isArray(obs) && obs.length > 0 && obs.length <= 200;
  const post = async (key: string, observations: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(`${base}/api/contract-observations`, { method: "POST", headers: { "content-type": "application/json", "x-surface-key": key }, body: JSON.stringify({ observations }) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  if (!usable) return post(deriveSurfaceKey(ingestKey, "checkout-journey", "web-checkout"), obs);
  const groups = new Map<string, { idx: number[]; items: unknown[] }>();
  (obs as Record<string, unknown>[]).forEach((o, i) => {
    const ok = typeof o === "object" && o !== null && slug.test(String(o.contractId)) && slug.test(String(o.surfaceId));
    const k = ok ? `${o.contractId}/${o.surfaceId}` : "checkout-journey/web-checkout"; const g = groups.get(k) ?? { idx: [], items: [] }; g.idx.push(i); g.items.push(o); groups.set(k, g); });
  const merged = { accepted: 0, duplicate: 0, rejected: 0, unlinked: 0, results: [] as any[] };
  for (const [k, g] of groups) {
    const [contractId, surfaceId] = k.split("/") as [string, string];
    const r = await post(deriveSurfaceKey(ingestKey, contractId, surfaceId), g.items);
    if (r.status !== 200) return r;
    for (const f of ["accepted", "duplicate", "rejected", "unlinked"] as const) merged[f] += r.json[f];
    r.json.results.forEach((x: any) => merged.results.push({ ...x, index: g.idx[x.index] }));
  }
  merged.results.sort((a, b) => a.index - b.index);
  return { status: 200, json: merged };
}
