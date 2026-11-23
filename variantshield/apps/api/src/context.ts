import type { AppConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { FlagsmithClient } from "../../../packages/flagsmith-adapter/src/index.ts";

export interface Ctx {
  cfg: AppConfig;
  db: Db;
  /** Wall clock, injectable for deterministic tests. */
  now: () => number;
  /** Flagsmith adapter, or null when FLAGSMITH_URL / keys are not configured. Never a stand-in. */
  flagsmith: FlagsmithClient | null;
}

export function buildFlagsmith(cfg: AppConfig, fetchImpl?: typeof fetch): FlagsmithClient | null {
  const f = cfg.flagsmith;
  if (!f.url || !f.environmentKey) return null;
  return new FlagsmithClient({ baseUrl: f.url, environmentKey: f.environmentKey, ...(f.admin ? { admin: f.admin } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}
