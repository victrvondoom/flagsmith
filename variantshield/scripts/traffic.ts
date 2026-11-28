import { parseArgs } from "node:util";

/**
 * Synthetic users hitting the real checkout demo over HTTP. Flagsmith assigns each identity its variant;
 * only the purchase intent below is synthetic behaviour, and it is labelled as such in every output.
 */
export const PURCHASE_INTENT: Record<string, number> = { control: 0.3, upi_first: 0.36, one_tap: 0.31 };

export interface TrafficOptions {
  baseUrl: string;
  users: number;
  uidPrefix: string;
  concurrency?: number;
  /** Probability a purchasing user double-clicks Pay (only goes through when the page has no guard). */
  doubleClickRate?: number;
  /** Deterministic randomness for reproducible runs. */
  random?: () => number;
}

export interface TrafficStats { variant: Record<string, { users: number; purchases: number; completed: number; declined: number; errors: number; doubleSubmits: number }>; unassigned: number }

export async function runTraffic(o: TrafficOptions): Promise<TrafficStats> {
  const rand = o.random ?? Math.random;
  const stats: TrafficStats = { variant: {}, unassigned: 0 };
  let next = 0;
  const user = async (i: number): Promise<void> => {
    const uid = `${o.uidPrefix}-${i}`;
    const h = { "x-demo-uid": uid, "content-type": "application/json" };
    const html = await (await fetch(`${o.baseUrl}/`, { headers: h })).text();
    const variant = /data-variant="(\w+)"/.exec(html)?.[1] ?? "control";
    if (/data-testid="assignment-banner"/.test(html)) stats.unassigned++;
    const s = (stats.variant[variant] ??= { users: 0, purchases: 0, completed: 0, declined: 0, errors: 0, doubleSubmits: 0 });
    s.users++;
    if (rand() >= (PURCHASE_INTENT[variant] ?? 0.3)) return;
    s.purchases++;
    const post = (key: string): Promise<Response> => fetch(`${o.baseUrl}/api/pay`, { method: "POST", headers: h, body: JSON.stringify({ idempotencyKey: key }) });
    const unguarded = html.includes('data-no-guard="true"');
    const double = unguarded && rand() < (o.doubleClickRate ?? 0.5);
    if (double) s.doubleSubmits++;
    const responses = await Promise.all(double ? [post(`${uid}-a`), post(`${uid}-b`)] : [post(`${uid}-a`)]);
    for (const r of responses) {
      const body = (await r.json()) as { status?: string };
      if (r.status >= 500) s.errors++; else if (body.status === "declined") s.declined++; else s.completed++;
    }
  };
  const worker = async (): Promise<void> => { while (next < o.users) await user(next++); };
  await Promise.all(Array.from({ length: o.concurrency ?? 25 }, worker));
  return stats;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { url: { type: "string", default: "http://127.0.0.1:8791" }, users: { type: "string", default: "1000" }, prefix: { type: "string", default: `run${Date.now()}` } } });
  console.log("SYNTHETIC USERS against the real demo; variants are assigned by Flagsmith, purchase intent is simulated.");
  const stats = await runTraffic({ baseUrl: values.url!, users: Number(values.users), uidPrefix: values.prefix! });
  console.table(stats.variant);
  if (stats.unassigned) console.warn(`${stats.unassigned} sessions had no Flagsmith assignment (see telemetry data-quality flag).`);
}
