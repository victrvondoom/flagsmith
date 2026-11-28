import { randomBytes } from "node:crypto";
import { FlagsmithClient } from "../../../packages/flagsmith-adapter/src/index.ts";
import { createDemoApp } from "./server.ts";
import { createTelemetry, noopTelemetry } from "./instrument.ts";

const env = process.env;
const flagsmith = env.FLAGSMITH_URL && env.FLAGSMITH_ENVIRONMENT_KEY ? new FlagsmithClient({ baseUrl: env.FLAGSMITH_URL, environmentKey: env.FLAGSMITH_ENVIRONMENT_KEY }) : null;
const telemetry = env.VARIANTSHIELD_URL && env.VARIANTSHIELD_INGEST_KEY
  ? createTelemetry({ url: env.VARIANTSHIELD_URL, ingestKey: env.VARIANTSHIELD_INGEST_KEY, experimentId: env.DEMO_EXPERIMENT_ID ?? null, featureKey: env.DEMO_FEATURE_KEY ?? "checkout_flow", onError: (e) => console.warn("telemetry:", String(e)) })
  : noopTelemetry;
const controlKey = env.DEMO_CONTROL_KEY ?? randomBytes(12).toString("base64url");
const port = Number(env.DEMO_PORT ?? 8791);
const host = env.DEMO_HOST ?? "127.0.0.1";

const { server } = createDemoApp({
  flagsmith, telemetry, onError: (e) => console.warn("demo:", String(e)),
  cfg: { featureKey: env.DEMO_FEATURE_KEY ?? "checkout_flow", latencyScale: Number(env.DEMO_LATENCY_SCALE ?? 1), allowOverride: env.DEMO_ALLOW_OVERRIDE === "true", allowUidHeader: env.DEMO_ALLOW_UID_HEADER === "true", controlKey, clientTimeoutMs: Number(env.DEMO_CLIENT_TIMEOUT_MS ?? 8000) },
});
server.listen(port, host, () => {
  console.log(`Checkout demo on http://${host}:${port}`);
  console.log(flagsmith ? "Variants served by Flagsmith." : "Flagsmith NOT configured: sessions have no assignment (set FLAGSMITH_URL and FLAGSMITH_ENVIRONMENT_KEY).");
  console.log(telemetry === noopTelemetry ? "Telemetry disabled (set VARIANTSHIELD_URL and VARIANTSHIELD_INGEST_KEY)." : "Telemetry -> VariantShield.");
  if (!env.DEMO_CONTROL_KEY) console.log(`Fault-injection key (ephemeral): ${controlKey}`);
});
