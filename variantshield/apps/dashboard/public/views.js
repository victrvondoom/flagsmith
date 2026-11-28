import { api, ApiError, imageUrl } from "./api.js";
import { chip, field, fmtMetric, fmtTime, h, pct, table, toast } from "./ui.js";

const COLUMNS = ["PLANNED", "CONFIGURED", "QUALIFYING", "RUNNING", "WARNING", "BREACH", "PAUSED", "COMPLETED"];
const errBanner = (e) => h("div", { class: "banner bad", role: "alert" }, e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));
// Widths are set through the CSSOM: a style="" attribute would be blocked by the page's Content Security Policy.
function barFill(cls, percent) { const el = h("div", { class: `fill ${cls}` }); el.style.width = `${percent}%`; return el; }
const simBadge = (yes) => (yes ? chip("SIM", "SIMULATION") : null);

/* ---------- A. Command Center ---------- */
export async function commandCenter({ navigate }) {
  const [o, board] = await Promise.all([api("GET", "/api/overview"), api("GET", "/api/board")]);
  const root = h("div", { class: "grid" });
  if (!o.flagsmith.configured) root.append(h("div", { class: "banner warn" }, "Flagsmith is not configured. Set FLAGSMITH_URL, FLAGSMITH_ENVIRONMENT_KEY and a Management API key on the VariantShield server. Real experiments, verdicts and control stay unavailable until then; simulation still works."));
  const fs = o.flagsmith;
  const conn = h("div", { class: "card" }, h("header", {}, h("h2", {}, "Flagsmith connection"), chip(fs.health.state === "ok" ? "ok" : fs.health.state === "not_configured" ? "none" : "error", fs.health.state)),
    h("dl", { class: "kv" }, h("dt", {}, "API URL"), h("dd", {}, fs.baseUrl || "not set"), h("dt", {}, "Environment key"), h("dd", {}, fs.environmentKey || "not set"), h("dt", {}, "Management credential"), h("dd", {}, fs.adminConfigured ? "configured (server-side only)" : "missing"), h("dt", {}, "Status"), h("dd", {}, fs.health.message)),
    h("div", { class: "row mt10" }, h("button", { onclick: async (ev) => { ev.target.disabled = true; try { const r = await api("POST", "/api/plans/import-flagsmith", {}); toast(`Imported ${r.imported} experiment(s) from Flagsmith`); navigate("#/command"); } catch (e) { toast(e.message); ev.target.disabled = false; } } }, "Import experiments from Flagsmith")));
  const states = h("div", { class: "card" }, h("header", {}, h("h2", {}, "Experiments by state")), h("div", { class: "row" }, COLUMNS.map((s) => h("span", {}, chip(s), " ", o.counts[s] || 0))));
  const alerts = h("div", { class: "card" }, h("header", {}, h("h2", {}, "Reliability alerts")),
    o.alerts.length ? h("ul", {}, o.alerts.map((a) => h("li", {}, chip(a.state), " ", h("a", { href: "#/verdict", onclick: () => sessionStorage.setItem("vs.plan", a.planId) }, a.title), " ", simBadge(a.simulated)))) : h("p", { class: "muted" }, "No warnings or breaches."));
  const vol = h("div", { class: "card" }, h("header", {}, h("h2", {}, "Telemetry volume"), h("span", { class: "muted" }, "real and simulated data are never mixed")),
    table(["Source", "Attribution", { label: "Events", num: true }], o.eventVolume.map((r) => h("tr", {}, h("td", {}, chip(r.source === "simulation" ? "SIM" : "ok", r.source)), h("td", {}, r.attribution), h("td", { class: "num" }, r.n))), { empty: "No telemetry received yet." }));
  const audit = h("div", { class: "card" }, h("header", {}, h("h2", {}, "Recent control actions")),
    table(["When", "Actor", "Action", "Outcome"], o.recentAudit.map((a) => h("tr", {}, h("td", {}, fmtTime(a.ts)), h("td", {}, a.actor), h("td", {}, `${a.action}${a.dry_run ? " (dry run)" : ""}`), h("td", {}, chip(a.outcome === "executed" ? "ok" : a.outcome === "dry_run" ? "none" : "failed", a.outcome), " ", simBadge(a.simulated)))), { empty: "No control actions yet." }));
  const demo = o.demoMode ? h("div", { class: "card" }, h("header", {}, h("h2", {}, "Simulation"), chip("SIM", "SYNTHETIC DATA")),
    h("p", { class: "muted" }, "Deterministic scenarios that generate labelled synthetic telemetry and a synthetic Flagsmith result. They never call Flagsmith and are kept apart from real observations."),
    h("div", { class: "row" }, ["safe-winner", "dangerous-winner"].map((id) => h("button", { onclick: async (ev) => { ev.target.disabled = true; try { const r = await api("POST", `/api/simulate/${id}`, {}); sessionStorage.setItem("vs.plan", r.plan.id); toast(`${r.events} simulated events created`); navigate("#/verdict"); } catch (e) { toast(e.message); ev.target.disabled = false; } } }, `Run ${id.replace("-", " ")}`)))) : null;
  root.append(h("div", { class: "grid g2" }, conn, states, alerts, vol, audit, demo));
  void board;
  return root;
}

/* ---------- B. Trial Board ---------- */
export async function trialBoard({ navigate }) {
  const { cards, bench } = await api("GET", "/api/board");
  const root = h("div", {});
  const drawerHost = h("div", {});
  const openPlan = (card) => drawerHost.replaceChildren(planDrawer(card, bench, () => navigate("#/board"), () => drawerHost.replaceChildren()));
  root.append(h("div", { class: "topbar" }, h("h1", {}, "Experiment Trial Board"), h("button", { class: "primary", onclick: () => drawerHost.replaceChildren(planDrawer(null, bench, () => navigate("#/board"), () => drawerHost.replaceChildren())) }, "New experiment plan")));
  root.append(h("p", { class: "muted" }, "Columns are derived from live backend state: Flagsmith's experiment status, the latest Variant Bench run, and guardrail results. Cards cannot be dragged because state is not a matter of opinion."));
  root.append(h("div", { class: "board" }, COLUMNS.map((s) => {
    const list = cards.filter((c) => c.state === s);
    return h("section", { class: "col", "aria-label": s }, h("h3", {}, h("span", {}, s), h("span", {}, list.length)),
      list.map((c) => h("button", { class: "plan", onclick: () => openPlan(c) }, h("span", { class: "t" }, c.plan.title),
        h("span", { class: "meta" }, simBadge(c.plan.isSimulation), c.flagsmith.stale ? chip("stale", "stale") : null, chip(c.plan.approval.status, `approval: ${c.plan.approval.status}`), c.reliability ? chip(c.reliability) : null))));
  })));
  root.append(drawerHost);
  return root;
}

function planDrawer(card, bench, done, close) {
  const p = card?.plan;
  const val = (k, d = "") => (p ? p[k] ?? d : d);
  const f = {
    title: h("input", { id: "f-title", value: val("title"), required: true, maxlength: 200 }),
    owner: h("input", { id: "f-owner", value: val("owner") }),
    problem: h("textarea", { id: "f-problem" }, val("businessProblem")),
    hypothesis: h("textarea", { id: "f-hyp" }, val("hypothesis")),
    control: h("input", { id: "f-control", value: val("controlVariant", "control") }),
    treatments: h("input", { id: "f-treat", value: (p?.treatmentVariants || []).join(", ") }),
    metric: h("input", { id: "f-metric", value: val("primaryMetric") }),
    feature: h("input", { id: "f-feature", value: val("featureKey") }),
    criteria: h("textarea", { id: "f-crit" }, (p?.acceptanceCriteria || []).join("\n")),
    guard: h("textarea", { id: "f-guard" }, JSON.stringify(p?.guardrailOverrides || {}, null, 2)),
  };
  const save = async () => {
    try {
      const body = { title: f.title.value, owner: f.owner.value, businessProblem: f.problem.value, hypothesis: f.hypothesis.value, controlVariant: f.control.value,
        treatmentVariants: f.treatments.value.split(",").map((s) => s.trim()).filter(Boolean), primaryMetric: f.metric.value, featureKey: f.feature.value,
        acceptanceCriteria: f.criteria.value.split("\n").map((s) => s.trim()).filter(Boolean), guardrailOverrides: JSON.parse(f.guard.value || "{}") };
      await (p ? api("PATCH", `/api/plans/${p.id}`, body) : api("POST", "/api/plans", body));
      toast("Saved"); done();
    } catch (e) { toast(e instanceof SyntaxError ? "Guardrail overrides must be valid JSON" : `${e.message}${e.detail ? `: ${[].concat(e.detail).join("; ")}` : ""}`); }
  };
  const link = h("input", { id: "f-link", inputmode: "numeric", placeholder: "Flagsmith experiment id", value: p?.flagsmithExperimentId ?? "" });
  const drawer = h("aside", { class: "drawer", role: "dialog", "aria-label": p ? "Edit experiment plan" : "New experiment plan" },
    h("div", { class: "topbar" }, h("h2", {}, p ? p.title : "New experiment plan"), h("button", { onclick: close }, "Close")),
    p ? h("div", { class: "row" }, simBadge(p.isSimulation), chip(card.state), card.flagsmith.status ? chip(card.flagsmith.status, `Flagsmith: ${card.flagsmith.status}`) : chip("none", "not linked"), card.flagsmith.error ? chip("stale", "stale") : null) : null,
    card?.flagsmith.error ? h("div", { class: "banner warn" }, `Flagsmith unreachable, showing last known status. ${card.flagsmith.error}`) : null,
    field("Title", f.title, "f-title"), field("Business problem", f.problem, "f-problem"), field("Hypothesis", f.hypothesis, "f-hyp"),
    field("Control variant", f.control, "f-control"), field("Treatment variants (comma separated)", f.treatments, "f-treat"),
    field("Feature key in Flagsmith", f.feature, "f-feature"), field("Primary conversion metric", f.metric, "f-metric"),
    field("Acceptance criteria (one per line)", f.criteria, "f-crit"), field("Reliability guardrail overrides (JSON, optional)", f.guard, "f-guard"), field("Assigned owner", f.owner, "f-owner"),
    h("div", { class: "row mt12" }, h("button", { class: "primary", onclick: save }, "Save plan"),
      p ? h("button", { onclick: async () => { if (confirm("Delete this plan? Flagsmith is not changed.")) { await api("DELETE", `/api/plans/${p.id}`); done(); } } }, "Delete") : null),
    p && !p.isSimulation ? h("div", {}, h("h3", { class: "mt16" }, "Flagsmith link"),
      h("div", { class: "row" }, link, h("button", { onclick: async () => { try { await api("POST", `/api/plans/${p.id}/link`, { flagsmithExperimentId: Number(link.value) }); toast("Linked and verified against Flagsmith"); done(); } catch (e) { toast(e.message); } } }, "Link"), p.flagsmithExperimentId ? h("button", { onclick: async () => { await api("POST", `/api/plans/${p.id}/unlink`, {}); done(); } }, "Unlink") : null)) : null,
    p ? approvalBlock(p, done) : null,
    p ? h("div", {}, h("h3", { class: "mt16" }, "Test execution history (latest Variant Bench run)"),
      bench.status === "none" ? h("p", { class: "muted" }, "No bench run yet.") : table(["Variant", "Passed", "Failed"], Object.entries(bench.variants).map(([v, s]) => h("tr", {}, h("td", {}, v), h("td", {}, s.passed), h("td", {}, s.failed))))) : null,
    p ? evidenceBlock(p) : null);
  return drawer;
}

function approvalBlock(p, done) {
  const note = h("input", { id: "f-note", placeholder: "Note (optional)", value: p.approval.note || "" });
  const set = (d) => async () => { try { await api("POST", `/api/plans/${p.id}/approval`, { decision: d, note: note.value }); toast(`Marked ${d}`); done(); } catch (e) { toast(e.message); } };
  return h("div", {}, h("h3", { class: "mt16" }, "Human approval"),
    h("p", {}, chip(p.approval.status), p.approval.by ? ` by ${p.approval.by} at ${fmtTime(p.approval.at)}` : " Nobody has approved this plan yet."),
    h("div", { class: "row" }, note, h("button", { onclick: set("approved") }, "Approve"), h("button", { onclick: set("rejected") }, "Reject"), h("button", { onclick: set("pending") }, "Reset")),
    h("p", { class: "muted" }, "Approval records a human decision on the plan. Pausing or completing an experiment is a separate confirmed action under Experiment Control."));
}

function evidenceBlock(p) {
  const host = h("div", {}, h("p", { class: "muted" }, "Loading evidence…"));
  api("GET", `/api/plans/${p.id}/evidence`).then(({ evidence }) => host.replaceChildren(table(["#", "Kind", "Captured", "By"], evidence.map((e) => h("tr", {}, h("td", {}, h("a", { href: `#/verdict`, onclick: () => sessionStorage.setItem("vs.plan", p.id) }, e.id)), h("td", {}, e.kind), h("td", {}, fmtTime(e.created_at)), h("td", {}, e.created_by))), { empty: "No evidence captured yet. Capture a snapshot in the Dual Verdict Room." }))).catch(() => {});
  return h("div", {}, h("h3", { class: "mt16" }, "Evidence records"), host);
}

/* ---------- C. Variant Bench ---------- */
export async function variantBench({ navigate }) {
  const { runs } = await api("GET", "/api/bench/runs");
  const root = h("div", { class: "grid" });
  const sel = h("select", { id: "fault", "aria-label": "Fault to inject into upi_first" },
    [["none", "No fault (clean qualification)"], ["payment_failures", "Inject payment failures"], ["duplicate_submissions", "Remove duplicate-submit guard"], ["slow_responses", "Inject slow responses"], ["server_errors", "Inject 5xx errors"]].map(([v, l]) => h("option", { value: v }, l)));
  const run = h("button", { class: "primary", onclick: async (ev) => { ev.target.disabled = true; try { await api("POST", "/api/bench/runs", { fault: sel.value }); toast("Bench started. This takes about 20 seconds."); setTimeout(() => navigate("#/bench"), 1500); } catch (e) { toast(e.message); ev.target.disabled = false; } } }, "Run Playwright suite");
  root.append(h("div", { class: "topbar" }, h("h1", {}, "Variant Bench"), h("div", { class: "ctl" }, h("label", { for: "fault", class: "nomargin" }, "Fault"), sel, run)));
  root.append(h("p", { class: "muted" }, "The same 9-test Playwright acceptance suite runs against control, upi_first and one_tap on a self-contained copy of the checkout demo. A fault is injected into upi_first only, to show how a variant can look fine yet be unsafe."));
  if (!runs.length) { root.append(h("div", { class: "card" }, "No bench runs yet. Run the suite to qualify the variants.")); return root; }
  const latest = runs[0];
  const detail = await api("GET", `/api/bench/runs/${latest.id}`);
  root.append(h("div", { class: "card" }, h("header", {}, h("h2", {}, `Latest run`), chip(latest.status), h("span", { class: "muted" }, `fault: ${latest.fault} · ${fmtTime(latest.started_at)}`)),
    latest.status === "running" ? h("p", {}, "Running. Refresh in a few seconds.") : null));
  if (detail.results.length) {
    const variants = [...new Set(detail.results.map((r) => r.variant))];
    const names = [...new Set(detail.results.map((r) => r.test_name))];
    const shot = h("div", { class: "card" }, h("p", { class: "muted" }, "Select a result to compare its screenshot across variants."));
    const show = async (name) => {
      const figs = await Promise.all(detail.results.filter((r) => r.test_name === name && r.screenshot).map(async (r) => {
        const img = h("img", { alt: `${r.variant} · ${name}: ${r.status}` });
        imageUrl(`/api/bench/runs/${latest.id}/screenshots/${r.screenshot}`).then((u) => { img.src = u; }).catch(() => {});
        return h("figure", {}, img, h("figcaption", {}, chip(r.status), ` ${r.variant}`, r.error ? ` · ${r.error}` : ""));
      }));
      shot.replaceChildren(h("header", {}, h("h2", {}, name), h("span", { class: "muted" }, "screenshot evidence")), h("div", { class: "shots" }, figs));
    };
    root.append(h("div", { class: "card" }, h("header", {}, h("h2", {}, "Acceptance matrix")),
      table(["Test", ...variants], names.map((n) => h("tr", {}, h("td", { class: "mono" }, n), variants.map((v) => { const r = detail.results.find((x) => x.variant === v && x.test_name === n); return h("td", {}, r ? h("button", { onclick: () => show(n), "aria-label": `${v} ${n}: ${r.status}` }, chip(r.status)) : "–"); }))), { class: "matrix" })));
    const failed = detail.results.filter((r) => r.status === "failed");
    root.append(h("div", { class: "card" }, h("header", {}, h("h2", {}, "Failed tests"), h("span", { class: "muted" }, failed.length)),
      table(["Variant", "Test", "Error"], failed.map((r) => h("tr", {}, h("td", {}, r.variant), h("td", { class: "mono" }, r.test_name), h("td", {}, r.error || ""))), { empty: "Every test passed on every variant." })), shot);
  }
  root.append(h("div", { class: "card" }, h("header", {}, h("h2", {}, "Run history")), table(["Started", "Fault", "Status"], runs.map((r) => h("tr", {}, h("td", {}, fmtTime(r.started_at)), h("td", {}, r.fault), h("td", {}, chip(r.status)))))));
  return root;
}

/* ---------- plan-scoped helpers ---------- */
async function planContext() {
  const { plans } = await api("GET", "/api/plans");
  if (!plans.length) return { plans, plan: null };
  const saved = Number(sessionStorage.getItem("vs.plan"));
  const plan = plans.find((p) => p.id === saved) || plans[0];
  return { plans, plan };
}
function planPicker(plans, plan, navigate) {
  return h("div", { class: "ctl" }, h("label", { for: "plan", class: "nomargin" }, "Experiment"),
    h("select", { id: "plan", onchange: (e) => { sessionStorage.setItem("vs.plan", e.target.value); navigate(location.hash); } }, plans.map((p) => h("option", { value: p.id, selected: p.id === plan.id }, p.title))));
}
const noPlans = h("div", { class: "card" }, "No experiment plans yet. Import experiments from Flagsmith on the Command Center, create a plan on the Trial Board, or run a simulation.");


/* ---------- charts (SVG, no inline styles: CSP forbids them) ---------- */
const SVGNS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}, ...kids) => { const el = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v)); for (const kid of kids.flat()) if (kid) el.append(kid); return el; };
const SERIES_CLASS = ["s0", "s1", "s2", "s3"];

/** Line chart of one metric across time buckets, one line per variant, with dashed warn/breach guardrail lines. */
function lineChart({ title, points, variants, pick, format, thresholds, unit }) {
  const W = 480, H = 210, L = 52, R = 12, T = 12, B = 28;
  const values = points.flatMap((p) => variants.map((v) => pick(p.variants[v]))).filter((x) => x !== null && x !== undefined);
  const lines = [thresholds?.warn, thresholds?.breach].filter((x) => x !== null && x !== undefined);
  const lastPoint = points[points.length - 1];
  const latest = lastPoint ? variants.map((v) => { const val = pick(lastPoint.variants[v]); return `${v}: ${val === null || val === undefined ? "no data" : format(val)}`; }).join(", ") : "";
  const root = h("div", { class: "chart", role: "img", "aria-label": `${title} over time per variant. Latest ${latest}${thresholds?.breach != null ? `. Breach threshold ${format(thresholds.breach)}` : ""}` }, h("h3", {}, title));
  if (!values.length) { root.append(h("p", { class: "muted" }, "No data in this range yet.")); return root; }
  const max = Math.max(...values, ...lines) * 1.15 || 1;
  const x = (i) => L + (i * (W - L - R)) / Math.max(1, points.length - 1);
  const y = (v) => T + (1 - v / max) * (H - T - B);
  const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", preserveAspectRatio: "xMidYMid meet" });
  for (let i = 0; i <= 4; i++) { const v = (max * i) / 4; g.append(svg("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid-line" }), svg("text", { x: L - 6, y: y(v) + 4, class: "axis", "text-anchor": "end" }, format(v))); }
  const stamp = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  [0, Math.floor(points.length / 2), points.length - 1].forEach((i) => g.append(svg("text", { x: x(i), y: H - 8, class: "axis", "text-anchor": i === 0 ? "start" : i === points.length - 1 ? "end" : "middle" }, stamp(points[i].endMs))));
  if (thresholds?.warn != null) g.append(svg("line", { x1: L, x2: W - R, y1: y(thresholds.warn), y2: y(thresholds.warn), class: "th warn" }), svg("text", { x: W - R, y: y(thresholds.warn) - 3, class: "axis th-label", "text-anchor": "end" }, "warn"));
  if (thresholds?.breach != null) g.append(svg("line", { x1: L, x2: W - R, y1: y(thresholds.breach), y2: y(thresholds.breach), class: "th breach" }), svg("text", { x: W - R, y: y(thresholds.breach) - 3, class: "axis th-label", "text-anchor": "end" }, "breach"));
  variants.forEach((v, vi) => {
    const cls = SERIES_CLASS[vi % SERIES_CLASS.length];
    let d = "";
    points.forEach((p, i) => { const val = pick(p.variants[v]); if (val === null || val === undefined) return; d += `${d && points[i - 1] && pick(points[i - 1].variants[v]) != null ? "L" : "M"}${x(i).toFixed(1)},${y(val).toFixed(1)} `; });
    g.append(svg("path", { d: d.trim(), class: `line ${cls}`, fill: "none" }));
    points.forEach((p, i) => { const val = pick(p.variants[v]); if (val === null || val === undefined) return; const dot = svg("circle", { cx: x(i), cy: y(val), r: 3, class: `dot ${cls}` }); dot.append(svg("title", {}, `${v} ${stamp(p.endMs)}: ${format(val)}${unit ?? ""} (${p.variants[v].sessions} checkouts)`)); g.append(dot); });
  });
  root.append(g, h("div", { class: "legend" }, variants.map((v, vi) => h("span", {}, h("span", { class: `swatch ${SERIES_CLASS[vi % SERIES_CLASS.length]}` }), ` ${v}`))));
  return root;
}

/* ---------- D. Reliability Observatory ---------- */
export async function observatory({ navigate }) {
  const { plans, plan } = await planContext();
  if (!plan) return noPlans;
  const [rel, ev, v, tl] = await Promise.all([api("GET", `/api/plans/${plan.id}/reliability`), api("GET", `/api/events/summary?source=${plan.isSimulation ? "simulation" : "real"}`), api("GET", `/api/plans/${plan.id}/verdict`), api("GET", `/api/plans/${plan.id}/timeline`)]);
  const root = h("div", { class: "grid" });
  root.append(h("div", { class: "topbar" }, h("h1", {}, "Reliability Observatory"), planPicker(plans, plan, navigate)));
  root.append(h("div", { class: `banner ${plan.isSimulation ? "sim" : ""}` }, plan.isSimulation ? chip("SIM", "SIMULATION") : chip("ok", "REAL TELEMETRY"), ` Baseline "${rel.report.baselineVariant}", window ${Math.round(rel.report.windowMs / 60000)} min, evaluated ${fmtTime(rel.report.evaluatedAtMs)}.`));
  rel.report.notes.forEach((n) => root.append(h("p", { class: "muted" }, n)));
  const T = tl.timeline;
  const pctFmt = (n) => `${(n * 100).toFixed(1)}%`;
  root.append(h("div", { class: "card" }, h("header", {}, h("h2", {}, "Timelines"), h("span", { class: "muted" }, `${T.points.length} buckets of ${Math.round(T.bucketMs / 60000)} min · dashed lines are the warn and breach guardrails relative to ${rel.report.baselineVariant}`)),
    h("div", { class: "grid g2" },
      lineChart({ title: "Payment failure rate", points: T.points, variants: T.variants, pick: (p) => p?.paymentFailureRate, format: pctFmt, thresholds: T.thresholds.payment_failure_rate }),
      lineChart({ title: "Checkout p95 latency", points: T.points, variants: T.variants, pick: (p) => p?.p95LatencyMs, format: (n) => `${Math.round(n)}ms`, thresholds: T.thresholds.checkout_p95_latency_ms }),
      lineChart({ title: "Duplicate submission rate", points: T.points, variants: T.variants, pick: (p) => p?.duplicateRate, format: pctFmt, thresholds: T.thresholds.duplicate_submission_rate }),
      lineChart({ title: "Conversion rate (observed checkouts)", points: T.points, variants: T.variants, pick: (p) => p?.conversionRate, format: pctFmt }))));
  if (!rel.report.variants.length) root.append(h("div", { class: "card" }, "No treatment variants configured on this plan."));
  for (const vr of rel.report.variants) {
    const rows = vr.metrics.map((m) => h("tr", {}, h("td", { class: "mono" }, m.metric), h("td", {}, chip(m.status)), h("td", { class: "num" }, fmtMetric(m.metric, m.treatment.value), h("br"), h("span", { class: "muted" }, `n=${m.treatment.sampleSize}`)),
      h("td", { class: "num" }, fmtMetric(m.metric, m.baseline.value), h("br"), h("span", { class: "muted" }, `n=${m.baseline.sampleSize}`)),
      h("td", { class: "num" }, m.ratio !== null ? `×${m.ratio.toFixed(2)}` : m.delta !== null ? `${m.delta >= 0 ? "+" : ""}${(m.delta * 100).toFixed(2)} pp` : "n/a", m.deltaLowerBound !== null ? h("br") : null, m.deltaLowerBound !== null ? h("span", { class: "muted" }, `lower ${(m.deltaLowerBound * 100).toFixed(2)} pp`) : null),
      h("td", { class: "mono" }, "warn " + ("warnDelta" in m.thresholds ? pct(m.thresholds.warnDelta) : `×${m.thresholds.warnRatio}`), h("br"), "breach " + ("breachDelta" in m.thresholds ? pct(m.thresholds.breachDelta) : `×${m.thresholds.breachRatio}`)),
      h("td", {}, m.reason)));
    const bars = vr.metrics.filter((m) => m.treatment.value !== null && m.baseline.value !== null).map((m) => {
      const max = Math.max(m.treatment.value, m.baseline.value) || 1;
      return h("div", {}, h("div", { class: "muted mono" }, m.metric), [["baseline", m.baseline.value, "base"], [vr.variantKey, m.treatment.value, ""]].map(([label, value, cls]) => h("div", { class: "bar" }, h("span", {}, label), h("div", { class: "track" }, barFill(cls, Math.max(2, (value / max) * 100))), h("span", { class: "mono" }, fmtMetric(m.metric, value)))));
    });
    root.append(h("div", { class: "card" }, h("header", {}, h("h2", {}, vr.variantKey), chip(vr.status), vr.dataQuality.flagged ? chip("WARNING", `${vr.dataQuality.unattributed} unattributed events`) : null),
      table(["Metric", "Status", "Treatment", "Baseline", "Difference", "Thresholds", "Why"], rows), h("div", { class: "grid g2 mt10" }, bars)));
  }
  const conv = v.verdict.experimentVerdict.summary;
  root.append(h("div", { class: "grid g2" },
    h("div", { class: "card" }, h("header", {}, h("h2", {}, "Conversion observations (from Flagsmith)"), chip(v.provenance.experiment === "simulation-fixture" ? "SIM" : v.provenance.experiment === "flagsmith" ? "ok" : "none", v.provenance.experiment)),
      conv ? table(["Variant", { label: "Identities", num: true }, { label: "Conversions", num: true }, { label: "Rate", num: true }], conv.variants.map((x) => h("tr", {}, h("td", {}, x.variant), h("td", { class: "num" }, x.evaluations), h("td", { class: "num" }, x.conversions), h("td", { class: "num" }, pct(x.conversionRate))))) : h("p", { class: "muted" }, "Flagsmith has not computed results.")),
    h("div", { class: "card" }, h("header", {}, h("h2", {}, "Telemetry events by variant")), table(["Event", "Variant", { label: "Count", num: true }], ev.byType.map((r) => h("tr", {}, h("td", { class: "mono" }, r.type), h("td", {}, r.variant_key ?? "(unattributed)"), h("td", { class: "num" }, r.n))), { empty: "No telemetry for this source." }))));
  return root;
}

/* ---------- E. Dual Verdict Room ---------- */
export async function verdictRoom({ navigate }) {
  const { plans, plan } = await planContext();
  if (!plan) return noPlans;
  const r = await api("GET", `/api/plans/${plan.id}/verdict`);
  const v = r.verdict;
  const root = h("div", { class: "grid" });
  root.append(h("div", { class: "topbar" }, h("h1", {}, "Dual Verdict Room"), planPicker(plans, plan, navigate)));
  root.append(h("div", { class: `banner ${v.outcome === "WINNER_BUT_UNSAFE" ? "bad" : v.outcome === "WINNER_AND_SAFE" ? "ok" : "warn"}` },
    h("div", { class: "row" }, chip(v.outcome), plan.isSimulation ? chip("SIM", "SIMULATION") : null), h("h2", { class: "mt6" }, v.headline),
    h("p", { class: "muted" }, `Recommended: ${v.recommendedAction.replaceAll("_", " ")}. Any experiment control action requires explicit human approval.`)));
  if (r.flagsmithError) root.append(h("div", { class: "banner warn", role: "alert" }, `Flagsmith data unavailable (${r.flagsmithError.kind}): ${r.flagsmithError.message}`));
  const a = v.experimentVerdict, b = v.reliabilityVerdict;
  root.append(h("div", { class: "grid g2" },
    h("div", { class: "card" }, h("header", {}, h("h2", {}, "Verdict A · Experiment result"), chip(a.state)), h("p", { class: "muted" }, `Source: ${r.provenance.experiment}. Flagsmith's own statistics, not recomputed here.`),
      h("p", {}, a.reason), a.summary ? h("dl", { class: "kv" }, h("dt", {}, "Winner"), h("dd", {}, a.winner || "none"), h("dt", {}, "Lift"), h("dd", {}, a.summary.lift || "n/a"), h("dt", {}, "Chance to win"), h("dd", {}, Object.entries(a.summary.chanceToWin).map(([k, x]) => `${k} ${(x * 100).toFixed(1)}%`).join(", ") || "n/a"), h("dt", {}, "Results as of"), h("dd", {}, a.summary.asOf || "n/a"), h("dt", {}, "Flagsmith status"), h("dd", {}, r.flagsmithStatus)) : null),
    h("div", { class: "card" }, h("header", {}, h("h2", {}, "Verdict B · Operational reliability"), chip(b.status)), h("p", { class: "muted" }, "Source: VariantShield telemetry, evaluated independently of conversion."), h("p", {}, b.reason),
      h("dl", { class: "kv" }, h("dt", {}, "Variants judged"), h("dd", {}, b.subjectVariants.join(", ") || "none"), ...b.variants.flatMap((x) => [h("dt", {}, x.variantKey), h("dd", {}, x.status)])))));
  root.append(h("div", { class: "card" }, h("header", {}, h("h2", {}, "Evidence"), h("span", { class: "muted" }, "time range, sample counts and thresholds behind each verdict")), h("ul", { class: "evidence" }, v.evidence.map((l) => h("li", { class: "mono" }, l)))));
  root.append(h("div", { class: "card" }, h("h3", {}, "Caveats"), h("ul", {}, v.caveats.map((c) => h("li", {}, c)))));
  root.append(h("div", { class: "row" },
    h("button", { onclick: async () => { try { const e = await api("POST", `/api/plans/${plan.id}/evidence`, {}); toast(`Evidence snapshot #${e.id} stored`); navigate("#/verdict"); } catch (x) { toast(x.message); } } }, "Capture evidence snapshot"),
    h("button", { class: v.recommendedAction === "pause" ? "danger" : "", onclick: () => navigate("#/control") }, v.recommendedAction === "pause" ? "Review pause in Experiment Control" : "Open Experiment Control")));
  const { evidence } = await api("GET", `/api/plans/${plan.id}/evidence`);
  root.append(h("div", { class: "card" }, h("header", {}, h("h2", {}, "Stored evidence")), table(["#", "Captured", "By", ""], evidence.map((e) => h("tr", {}, h("td", {}, e.id), h("td", {}, fmtTime(e.created_at)), h("td", {}, e.created_by), h("td", {}, h("button", { onclick: async () => { const d = await api("GET", `/api/evidence/${e.id}`); const dlg = h("dialog", {}, h("h2", {}, `Evidence #${e.id}`), h("pre", { class: "mono pre" }, JSON.stringify(d.payload, null, 2)), h("button", { onclick: () => dlg.close() }, "Close")); document.body.append(dlg); dlg.addEventListener("close", () => dlg.remove()); dlg.showModal(); } }, "View")))), { empty: "No snapshots yet." })));
  return root;
}

/* ---------- F. Experiment Control ---------- */
export async function control({ navigate }) {
  const { plans, plan } = await planContext();
  if (!plan) return noPlans;
  const root = h("div", { class: "grid" });
  root.append(h("div", { class: "topbar" }, h("h1", {}, "Experiment Control"), planPicker(plans, plan, navigate)));
  let status;
  try { status = await api("GET", `/api/control/${plan.id}/status`); } catch (e) { root.append(errBanner(e)); return root; }
  root.append(h("div", { class: "banner" }, h("div", { class: "row" }, chip(status.status || "unknown", `Flagsmith status: ${status.status ?? "unknown"}`), plan.isSimulation ? chip("SIM", "SIMULATION: no Flagsmith call is made") : chip("ok", "LIVE: calls Flagsmith")),
    h("p", { class: "muted" }, "Nothing here runs automatically. Every action is a dry run first, then needs a typed confirmation and a reason. After the call VariantShield re-reads Flagsmith and verifies the new state.")));
  const result = h("div", {});
  const ALLOWED = { pause: ["running"], resume: ["paused"], complete: ["running", "paused"] };
  const run = async (action, dryRun, extra) => {
    try {
      const r = await api("POST", "/api/control", { planId: plan.id, action, dryRun, ...extra });
      result.replaceChildren(h("div", { class: "banner ok" }, h("strong", {}, r.outcome === "dry_run" ? "Dry run: nothing changed. " : "Executed. "), `Before: ${r.before} → After: ${r.after}. `, h("span", { class: "mono" }, r.wouldCall)));
      if (!dryRun) setTimeout(() => navigate("#/control"), 1200);
      return true;
    } catch (e) { result.replaceChildren(errBanner(e)); return false; }
  };
  const dialog = (action) => {
    const confirm = h("input", { id: "c-confirm", autocomplete: "off", placeholder: status.confirmations[action] });
    const reason = h("textarea", { id: "c-reason", placeholder: "Why are you doing this? Recorded in the audit log." });
    const go = h("button", { class: "danger", disabled: true }, `${action[0].toUpperCase()}${action.slice(1)} experiment`);
    const dlg = h("dialog", { "aria-label": `Confirm ${action}` }, h("h2", {}, `Confirm: ${action}`),
      h("p", {}, `Flagsmith currently reports `, chip(status.status), `. This will call Flagsmith's ${action === "resume" ? "start" : action} operation${plan.isSimulation ? " (simulated here)" : ""}.`),
      action === "complete" ? h("p", { class: "banner bad" }, "Completing is permanent. A completed experiment cannot be restarted.") : null,
      field(`Type ${status.confirmations[action]} to confirm`, confirm, "c-confirm"), field("Reason (min 10 characters)", reason, "c-reason"),
      h("div", { class: "row mt12" }, h("button", { onclick: () => dlg.close() }, "Cancel"), go));
    const check = () => { go.disabled = confirm.value !== status.confirmations[action] || reason.value.trim().length < 10; };
    confirm.addEventListener("input", check); reason.addEventListener("input", check);
    go.addEventListener("click", async () => { go.disabled = true; const ok = await run(action, false, { confirmation: confirm.value, reason: reason.value }); if (ok) dlg.close(); else check(); });
    dlg.addEventListener("close", () => dlg.remove());
    document.body.append(dlg); dlg.showModal(); confirm.focus();
  };
  root.append(h("div", { class: "grid g3" }, ["pause", "resume", "complete"].map((a) => {
    const ok = (ALLOWED[a] || []).includes(status.status);
    return h("div", { class: "card" }, h("header", {}, h("h2", {}, a[0].toUpperCase() + a.slice(1))), h("p", { class: "muted" }, ok ? `Allowed from "${status.status}".` : `Not allowed while Flagsmith reports "${status.status}".`),
      h("div", { class: "row" }, h("button", { disabled: !ok, onclick: () => run(a, true) }, "Dry run"), h("button", { class: a === "pause" ? "primary" : "", disabled: !ok, onclick: () => dialog(a) }, "Review and confirm…")));
  })));
  root.append(result);
  const { audit } = await api("GET", "/api/audit");
  root.append(h("div", { class: "card" }, h("header", {}, h("h2", {}, "Audit trail")),
    table(["When", "Actor", "Action", "Outcome", "Before", "After", "Reason"], audit.filter((x) => x.plan_id === plan.id).map((x) => h("tr", {}, h("td", {}, fmtTime(x.ts)), h("td", {}, x.actor), h("td", {}, `${x.action}${x.dry_run ? " (dry run)" : ""}`), h("td", {}, chip(x.outcome === "executed" ? "ok" : x.outcome === "dry_run" ? "none" : "failed", x.outcome), x.simulated ? chip("SIM", "SIM") : null), h("td", {}, x.before_state || ""), h("td", {}, x.after_state || ""), h("td", {}, x.reason || ""))), { empty: "No actions recorded for this experiment." })));
  return root;
}
