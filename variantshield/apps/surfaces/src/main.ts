import { randomBytes } from "node:crypto";
import { FlagsmithClient } from "../../../packages/flagsmith-adapter/src/index.ts";
import { createSurface, SURFACES } from "./surface.ts";

const env = process.env;
const need = (k: string): string => { const v = env[k]; if (!v) { console.error(`Set ${k}`); process.exit(2); } return v; };
const flagsmith = new FlagsmithClient({ baseUrl: need("FLAGSMITH_URL"), environmentKey: need("FLAGSMITH_ENVIRONMENT_KEY") });
const controlKey = env.SURFACE_CONTROL_KEY ?? randomBytes(12).toString("base64url");
// One key per surface, bound to (contract, surface): `npm run vs -- contract surface-keys --contract <id> --json` prints them.
// SURFACE_KEYS is a JSON object { "<surfaceId>": "<key>" }. Each surface process only needs its own entry.
let surfaceKeys: Record<string, string> = {};
try { surfaceKeys = JSON.parse(need("SURFACE_KEYS")) as Record<string, string>; } catch { console.error("SURFACE_KEYS must be a JSON object of surfaceId -> key"); process.exit(2); }
const base = Number(env.SURFACES_BASE_PORT ?? 8801);
const host = env.SURFACES_HOST ?? "127.0.0.1";

SURFACES.forEach((def, i) => {
  const { server } = createSurface({
    def, flagsmith, environmentKey: need("FLAGSMITH_ENVIRONMENT_KEY"), environmentName: env.CONTRACT_ENVIRONMENT ?? "production", variantshieldUrl: env.VARIANTSHIELD_URL ?? "http://127.0.0.1:8787",
    surfaceKey: surfaceKeys[def.id] ?? (console.error(`SURFACE_KEYS has no key for ${def.id}`), process.exit(2)), contractId: env.CONTRACT_ID ?? "checkout-journey", contractVersion: Number(env.CONTRACT_VERSION ?? 1), experimentKey: env.CONTRACT_EXPERIMENT ?? "checkout_journey",
    assignmentFlag: env.CONTRACT_ASSIGNMENT_FLAG ?? "checkout_journey_variant", controlKey,
  });
  server.listen(base + i, host, () => console.log(`${def.id.padEnd(16)} http://${host}:${base + i}`));
});
if (!env.SURFACE_CONTROL_KEY) console.log(`Fault-injection key (ephemeral): ${controlKey}`);
