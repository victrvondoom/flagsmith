import { api, ApiError, session } from "./api.js";
import { chip, h, toast } from "./ui.js";
import { commandCenter, control, observatory, trialBoard, variantBench, verdictRoom } from "./views.js";
import { contractsView } from "./contracts.js";
import { integrationView } from "./integration.js";

const ROUTES = [
  ["#/command", "Command Center", commandCenter], ["#/board", "Trial Board", trialBoard], ["#/bench", "Variant Bench", variantBench],
  ["#/observatory", "Reliability Observatory", observatory], ["#/verdict", "Dual Verdict Room", verdictRoom], ["#/control", "Experiment Control", control], ["#/contracts", "Cross-Surface Contracts", contractsView], ["#/integration", "Integration", integrationView],
];
const app = document.getElementById("app");

function login(message) {
  const token = h("input", { id: "token", type: "password", autocomplete: "off", required: true });
  const actor = h("input", { id: "actor", autocomplete: "name", placeholder: "Your name (recorded in the audit log)", value: session.actor, maxlength: 64 });
  app.replaceChildren(h("main", { id: "main", class: "login card" }, h("h1", {}, "VARIANTSHIELD"),
    h("p", { class: "muted" }, "Variant-level reliability guardrails for Flagsmith experiments. Independent community project, not an official Flagsmith product."),
    message ? h("div", { class: "banner bad", role: "alert" }, message) : null,
    h("form", { onsubmit: async (e) => { e.preventDefault(); session.token = token.value.trim(); session.actor = actor.value.trim(); try { await api("GET", "/api/plans"); location.hash = "#/command"; render(); } catch (x) { session.token = ""; login(x instanceof ApiError && x.status === 401 ? "That admin token was not accepted." : x.message); } } },
      h("label", { for: "token" }, "Admin token (VARIANTSHIELD_ADMIN_TOKEN)"), token, h("label", { for: "actor" }, "Actor name"), actor, h("p", {}, h("button", { class: "primary", type: "submit" }, "Sign in")),
      h("p", { class: "muted" }, "The token is kept in this tab's session storage only and sent to this server."))));
}

async function render() {
  if (!session.token) return login();
  const hash = ROUTES.some((r) => r[0] === location.hash) ? location.hash : "#/command";
  const [, title, view] = ROUTES.find((r) => r[0] === hash);
  const nav = h("nav", { class: "side", "aria-label": "Primary" }, h("div", { class: "brand" }, h("img", { src: "/favicon.svg", alt: "" }), "VARIANTSHIELD"),
    ROUTES.map(([href, label]) => h("a", { href, "aria-current": href === hash ? "page" : null }, label)),
    h("div", { class: "disclaimer" }, "Independent community project. Not an official Flagsmith product or an endorsed integration.", h("br"), h("br"),
      h("button", { onclick: () => { session.token = ""; render(); } }, "Sign out")));
  const main = h("main", { id: "main" }, h("p", { class: "muted", role: "status" }, `Loading ${title}…`));
  app.replaceChildren(h("div", { class: "shell" }, nav, main));
  document.title = `${title} · VariantShield`;
  try {
    main.replaceChildren(await view({ navigate: (to) => { if (location.hash === to) render(); else location.hash = to; } }));
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { session.token = ""; return login("Your session is no longer valid. Sign in again."); }
    main.replaceChildren(h("div", { class: "banner bad", role: "alert" }, `Could not load ${title}: ${e.message}`), h("button", { onclick: render }, "Retry"));
  }
}

addEventListener("hashchange", render);
render();
void chip; void toast;
