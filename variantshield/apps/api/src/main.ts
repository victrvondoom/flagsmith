import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { createApp } from "./app.ts";
import { buildFlagsmith } from "./context.ts";

const cfg = loadConfig();
const db = new Db(cfg.dbPath);
const ctx = { cfg, db, now: () => Date.now(), flagsmith: buildFlagsmith(cfg) };
const { server } = createApp(ctx);

const purge = (): void => {
  const removed = db.purgeEventsOlderThan(Date.now() - cfg.retentionDays * 86_400_000);
  if (removed > 0) console.log(JSON.stringify({ msg: "retention.purged", removed }));
};
purge();
setInterval(purge, 3_600_000).unref();

server.listen(cfg.port, cfg.host, () => {
  console.log(`VariantShield API listening on http://${cfg.host}:${cfg.port}`);
  console.log(ctx.flagsmith ? `Flagsmith: ${JSON.stringify(ctx.flagsmith.describe())}` : "Flagsmith: not configured (set FLAGSMITH_URL, FLAGSMITH_ENVIRONMENT_KEY, FLAGSMITH_ADMIN_API_KEY)");
  if (cfg.ephemeralSecrets) {
    console.log("No VARIANTSHIELD_ADMIN_TOKEN / VARIANTSHIELD_INGEST_KEY set: using ephemeral development secrets (regenerated each start).");
    console.log(`  admin token: ${cfg.adminToken}`);
    console.log(`  ingest key:  ${cfg.ingestKey}`);
    console.log(`  identity issuer key: ${cfg.identityIssuerKey}`);
  }
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
