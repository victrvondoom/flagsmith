import { randomBytes } from "node:crypto";
import { mergeConfig, type DeepPartial, type GuardrailConfig } from "../../../packages/guardrail-engine/src/index.ts";

export interface AppConfig {
  host: string;
  port: number;
  dbPath: string;
  adminToken: string;
  ingestKey: string;
  ephemeralSecrets: boolean;
  corsOrigins: string[];
  retentionDays: number;
  demoMode: boolean;
  flagsmith: {
    url: string | null;
    environmentKey: string | null;
    admin: { scheme: "Api-Key" | "Token"; value: string } | null;
  };
  guardrails: GuardrailConfig;
  benchOutputDir: string;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): AppConfig {
  const production = env.NODE_ENV === "production";
  let ephemeral = false;
  const secret = (name: string): string => {
    const v = env[name];
    if (v) {
      if (v.length < 16) throw new Error(`${name} must be at least 16 characters`);
      return v;
    }
    if (production) throw new Error(`${name} is required when NODE_ENV=production`);
    ephemeral = true;
    return randomBytes(18).toString("base64url");
  };
  const adminKey = env.FLAGSMITH_ADMIN_API_KEY;
  const adminToken = env.FLAGSMITH_ADMIN_TOKEN;
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be 0-65535");
  const overrides = env.GUARDRAIL_CONFIG_JSON ? (JSON.parse(env.GUARDRAIL_CONFIG_JSON) as DeepPartial<GuardrailConfig>) : {};
  return {
    host: env.HOST ?? "127.0.0.1",
    port,
    dbPath: env.VARIANTSHIELD_DB_PATH ?? "data/variantshield.db",
    adminToken: secret("VARIANTSHIELD_ADMIN_TOKEN"),
    ingestKey: secret("VARIANTSHIELD_INGEST_KEY"),
    ephemeralSecrets: ephemeral,
    corsOrigins: (env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    retentionDays: Number(env.RETENTION_DAYS ?? 10),
    demoMode: env.VARIANTSHIELD_DEMO_MODE !== "false",
    flagsmith: {
      url: env.FLAGSMITH_URL ?? null,
      environmentKey: env.FLAGSMITH_ENVIRONMENT_KEY ?? null,
      admin: adminKey ? { scheme: "Api-Key", value: adminKey } : adminToken ? { scheme: "Token", value: adminToken } : null,
    },
    guardrails: mergeConfig(overrides),
    benchOutputDir: env.VARIANTSHIELD_BENCH_DIR ?? "data/bench",
  };
}
