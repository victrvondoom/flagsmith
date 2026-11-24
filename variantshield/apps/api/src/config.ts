import { createHmac, randomBytes } from "node:crypto";
import { mergeConfig, type DeepPartial, type GuardrailConfig } from "../../../packages/guardrail-engine/src/index.ts";

export interface AppConfig {
  host: string;
  port: number;
  dbPath: string;
  adminToken: string;
  ingestKey: string;
  /** HMAC key for pseudonymous subject references and identity tokens. Never leaves the server. */
  identitySecret: string;
  /** Credential for the trusted backend that issues identity tokens. */
  identityIssuerKey: string;
  /** Signs identity tokens. Separate from `identitySecret` (which fixes pseudonymous subject refs and must never rotate). */
  identityTokenSecret: string;
  /** Older token-signing secrets still accepted for verification during a rotation. */
  identityTokenPrevious: string[];
  /** Optional read-only credential: may call GET routes (including /metrics) but nothing that changes state or reveals keys. */
  viewerToken: string | null;
  /** Trust the last X-Forwarded-For hop as the client address (only behind a proxy you control). */
  trustProxy: boolean;
  /** Hard cap on stored observations per contract; ingest returns 429 beyond it. */
  maxObservationsPerContract: number;
  /** Retention for findings, drift and configuration snapshots (observations use retentionDays). */
  historyRetentionDays: number;
  /** Signs ledger entries (HMAC). First key signs; the rest are accepted for verification after a rotation. */
  ledgerKeys: string[];
  /** Let the person who proposed a decision also approve it. Off by default: an official decision needs a second named actor. */
  allowSelfApproval: boolean;
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
      // In production a secret must look random: long enough and not a repeated or trivial pattern.
      if (production && (v.length < 24 || new Set(v).size < 10)) throw new Error(`${name} is too weak for production: use at least 24 characters from a random generator (e.g. openssl rand -base64 32)`);
      return v;
    }
    if (production) throw new Error(`${name} is required when NODE_ENV=production`);
    ephemeral = true;
    return randomBytes(18).toString("base64url");
  };
  const identitySecret = secret("VARIANTSHIELD_IDENTITY_SECRET");
  const tokenSecretEnv = env.VARIANTSHIELD_IDENTITY_TOKEN_SECRET;
  if (tokenSecretEnv !== undefined && tokenSecretEnv.length < 16) throw new Error("VARIANTSHIELD_IDENTITY_TOKEN_SECRET must be at least 16 characters");
  const viewerEnv = env.VARIANTSHIELD_VIEWER_TOKEN;
  if (viewerEnv !== undefined && viewerEnv !== "" && viewerEnv.length < 16) throw new Error("VARIANTSHIELD_VIEWER_TOKEN must be at least 16 characters");
  const intEnv = (name: string, dflt: number, min: number): number => {
    const v = env[name] === undefined ? dflt : Number(env[name]);
    if (!Number.isInteger(v) || v < min) throw new Error(`${name} must be an integer >= ${min}`);
    return v;
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
    identitySecret,
    identityIssuerKey: secret("VARIANTSHIELD_IDENTITY_ISSUER_KEY"),
    identityTokenSecret: tokenSecretEnv || createHmac("sha256", identitySecret).update("vs-token-key:v1").digest("base64url"),
    identityTokenPrevious: (env.VARIANTSHIELD_IDENTITY_TOKEN_PREVIOUS ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    viewerToken: viewerEnv ? viewerEnv : null,
    ledgerKeys: [env.VARIANTSHIELD_LEDGER_KEY || createHmac("sha256", identitySecret).update("vs-ledger-key:v1").digest("base64url"), ...(env.VARIANTSHIELD_LEDGER_KEY_PREVIOUS ?? "").split(",").map((x) => x.trim()).filter(Boolean)],
    allowSelfApproval: env.VARIANTSHIELD_ALLOW_SELF_APPROVAL === "true",
    trustProxy: env.VARIANTSHIELD_TRUST_PROXY === "true",
    maxObservationsPerContract: intEnv("VARIANTSHIELD_MAX_OBSERVATIONS_PER_CONTRACT", 500_000, 1000),
    historyRetentionDays: intEnv("VARIANTSHIELD_HISTORY_RETENTION_DAYS", 365, 1),
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
