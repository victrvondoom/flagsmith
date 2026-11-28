import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { Ctx } from "./context.ts";
import { HttpError } from "./http.ts";

export interface BenchTestResult { variant: string; name: string; status: "passed" | "failed"; durationMs: number; error?: string; screenshot?: string }

export const FAULTS = ["none", "payment_failures", "duplicate_submissions", "slow_responses", "server_errors"] as const;
export type Fault = (typeof FAULTS)[number];

const RUNNER = resolve(import.meta.dirname, "../../variant-bench/src/run.ts");
let active: string | null = null;

/** Starts the Playwright suite in a child process (no shell). Results are read back from results.json, never trusted from the child's stdout. */
export function startBenchRun(ctx: Ctx, opts: { fault: Fault; target?: string }): { runId: string } {
  if (active) throw new HttpError(409, "bench_in_progress", "A bench run is already in progress");
  if (!FAULTS.includes(opts.fault)) throw new HttpError(400, "validation_failed", `fault must be one of ${FAULTS.join(", ")}`);
  // Default: the runner starts its own copy of the checkout demo. An explicit target must be a local demo started with DEMO_ALLOW_OVERRIDE=true.
  const target = opts.target ?? null;
  if (target !== null && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(target)) throw new HttpError(400, "validation_failed", "Bench target must be a local checkout demo URL (http://127.0.0.1:PORT)");
  const runId = randomUUID();
  const out = resolve(ctx.cfg.benchOutputDir, runId);
  mkdirSync(out, { recursive: true });
  ctx.db.run("INSERT INTO bench_runs (id, status, started_at, target, fault) VALUES (?,?,?,?,?)", runId, "running", ctx.now(), target ?? "self-contained", opts.fault);
  active = runId;
  const child = spawn(process.execPath, [RUNNER, "--out", out, "--fault", opts.fault, ...(target ? ["--target", target] : [])], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: "" } });
  let log = "";
  const collect = (b: Buffer): void => { log = (log + b.toString()).slice(-20_000); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("close", (code) => {
    active = null;
    try {
      const file = join(out, "results.json");
      if (code !== 0 && !existsSync(file)) throw new Error(`runner exited with ${code}`);
      const results = JSON.parse(readFileSync(file, "utf8")) as { results: BenchTestResult[] };
      ctx.db.tx(() => {
        for (const r of results.results) ctx.db.run("INSERT INTO bench_results (run_id, variant, test_name, status, duration_ms, error, screenshot) VALUES (?,?,?,?,?,?,?)", runId, r.variant, r.name, r.status, Math.round(r.durationMs), r.error ?? null, r.screenshot ?? null);
        const failed = results.results.filter((r) => r.status === "failed").length;
        ctx.db.run("UPDATE bench_runs SET status=?, finished_at=?, summary=?, log=? WHERE id=?", failed ? "failed" : "passed", ctx.now(), JSON.stringify({ total: results.results.length, failed }), log, runId);
      });
    } catch (e) {
      ctx.db.run("UPDATE bench_runs SET status='errored', finished_at=?, log=? WHERE id=?", ctx.now(), `${String(e)}\n${log}`, runId);
    }
  });
  return { runId };
}

export function benchRunDetail(ctx: Ctx, runId: string): unknown {
  const run = ctx.db.get("SELECT * FROM bench_runs WHERE id = ?", runId);
  if (!run) throw new HttpError(404, "bench_run_not_found", "No such bench run");
  const results = ctx.db.all("SELECT variant, test_name, status, duration_ms, error, screenshot FROM bench_results WHERE run_id = ? ORDER BY variant, id", runId);
  return { run: { id: run.id, status: run.status, startedAt: run.started_at, finishedAt: run.finished_at, target: run.target, fault: run.fault, summary: run.summary ? JSON.parse(String(run.summary)) : null, log: run.log }, results };
}

/** Resolves a screenshot path under the run's output directory, refusing traversal. */
export function screenshotPath(ctx: Ctx, runId: string, file: string): string {
  if (!/^[0-9a-f-]{36}$/.test(runId) || !/^[\w.-]+\.png$/.test(file)) throw new HttpError(404, "not_found", "Not found");
  const p = resolve(ctx.cfg.benchOutputDir, runId, "screenshots", file);
  if (!p.startsWith(resolve(ctx.cfg.benchOutputDir, runId)) || !existsSync(p)) throw new HttpError(404, "not_found", "Not found");
  return p;
}
