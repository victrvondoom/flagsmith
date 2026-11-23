import { monitorEventLoopDelay } from "node:perf_hooks";

/** Minimal in-process Prometheus exposition. No dependency, bounded label cardinality (labels come from fixed sets). */
const counters = new Map<string, number>();
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
const startedAt = Date.now();

export function inc(name: string, labels: Record<string, string> = {}, by = 1): void {
  const key = `${name}${Object.keys(labels).length ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v.replace(/[^\w.-]/g, "_")}"`).join(",")}}` : ""}`;
  if (counters.size > 500 && !counters.has(key)) return; // hard stop against label explosion
  counters.set(key, (counters.get(key) ?? 0) + by);
}

export function render(extra: Record<string, number> = {}): string {
  const lines: string[] = ["# VariantShield metrics (independent open-source project, not an official Flagsmith product)"];
  for (const [k, v] of [...counters.entries()].sort()) lines.push(`variantshield_${k} ${v}`);
  lines.push(`variantshield_event_loop_delay_p99_seconds ${(loop.percentile(99) / 1e9).toFixed(6)}`);
  lines.push(`variantshield_event_loop_delay_max_seconds ${(loop.max / 1e9).toFixed(6)}`);
  lines.push(`variantshield_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`);
  lines.push(`variantshield_process_resident_memory_bytes ${process.memoryUsage().rss}`);
  for (const [k, v] of Object.entries(extra)) lines.push(`variantshield_${k} ${v}`);
  return `${lines.join("\n")}\n`;
}
