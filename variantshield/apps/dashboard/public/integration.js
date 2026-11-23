import { api, ApiError } from "./api.js";
import { chip, h } from "./ui.js";

const yes = (v) => chip(v ? "ok" : "none", v ? "set" : "not set");

export async function integrationView({ navigate }) {
  const root = h("div", { class: "grid" });
  root.append(h("div", { class: "topbar" }, h("h1", {}, "Integration")));
  let d;
  try { d = await api("GET", "/api/integration"); } catch (e) {
    root.append(h("div", { class: "banner bad", role: "alert" }, e instanceof ApiError ? `${e.code}: ${e.message}` : String(e)));
    return root;
  }
  const fl = d.flagsmith;
  const healthState = fl.health?.state ?? "unknown";
  root.append(h("p", { class: "muted" }, "How this VariantShield instance is wired. It is read from the running backend. Secret values are never shown, only whether they are set. Change them with environment variables and restart."));
  if (d.demoMode) root.append(h("div", { class: "banner" }, "DEMO MODE: simulation scenarios are enabled and are always labelled SIMULATION."));
  if (d.secrets.ephemeral) root.append(h("div", { class: "banner warn" }, "Ephemeral development secrets are in use. They change on every restart. Set the VARIANTSHIELD_* secrets for anything persistent."));

  const kv = (rows) => h("dl", { class: "kv" }, rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
  root.append(h("div", { class: "card" }, h("h2", {}, "Flagsmith connection"), kv([
    ["Status", chip(healthState === "ok" ? "ok" : healthState === "not_configured" ? "none" : "WARNING", String(healthState).replaceAll("_", " "))],
    ["Base URL", fl.baseUrl ?? "not set (FLAGSMITH_URL)"],
    ["Environment key", fl.environmentKey ?? "not set (FLAGSMITH_ENVIRONMENT_KEY)"],
    ["Management credential", yes(fl.adminConfigured)],
    ["Detail", fl.health?.message ?? ""],
  ]), h("button", { type: "button", onclick: () => navigate(location.hash) }, "Re-test connection")));

  root.append(h("div", { class: "card" }, h("h2", {}, "Secrets (values hidden)"), kv([
    ["Admin token (dashboard and API)", yes(d.secrets.adminToken)],
    ["Ingest key (telemetry and observations)", yes(d.secrets.ingestKey)],
    ["Identity secret (signs subject refs)", yes(d.secrets.identitySecret)],
    ["Identity issuer key (mints tokens)", yes(d.secrets.identityIssuerKey)],
  ])));

  root.append(h("div", { class: "card" }, h("h2", {}, "Endpoints for your services"), kv(Object.entries(d.endpoints).map(([k, v]) => [k, `${v.path}  (${v.auth})`]))));
  root.append(h("div", { class: "card" }, h("h2", {}, "Runtime"), kv([
    ["Version", d.version], ["Contracts registered", String(d.contracts.registered)], ["Event retention", `${d.retentionDays} days`],
    ["CORS origins", d.corsOrigins.length ? d.corsOrigins.join(", ") : "none (same origin only)"],
  ])));
  return root;
}
