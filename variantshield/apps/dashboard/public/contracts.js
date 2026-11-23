import { api, ApiError } from "./api.js";
import { chip, fmtTime, h, table, toast } from "./ui.js";

const TABS = [["overview", "Overview"], ["matrix", "Surface assignment matrix"], ["combinations", "Feature combination matrix"], ["drift", "Contract drift"], ["evidence", "Contract evidence"]];
const short = (ref) => (ref ? `${ref.slice(0, 9)}…${ref.slice(-4)}` : "(unlinked)");
const sevChip = (sev) => chip(sev === "error" ? "BREACH" : sev === "warning" ? "WARNING" : "none", sev);
const errBox = (e) => h("div", { class: "banner bad", role: "alert" }, e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));
const simBadge = (yes) => (yes ? chip("SIM", "SIMULATION") : null);
const statusClass = { CONTRACT_VALID: "ok", CONTRACT_VIOLATION: "BREACH", CONTRACT_INCOMPLETE: "WARNING", NO_DATA: "none", compliant: "ok", violating: "BREACH", incomplete: "WARNING", no_data: "none", valid: "ok", invalid: "BREACH" };
const statusChip = (s, label) => chip(statusClass[s] ?? "none", label ?? String(s).replaceAll("_", " "));

export async function contractsView({ navigate }) {
  const { contracts } = await api("GET", "/api/contracts");
  const scen = await api("GET", "/api/contract-scenarios").catch(() => ({ enabled: false, scenarios: [] }));
  const root = h("div", { class: "grid" });
  const savedId = sessionStorage.getItem("vs.contract");
  const current = contracts.find((c) => c.id === savedId) ?? contracts[0] ?? null;
  const tab = TABS.some(([k]) => k === sessionStorage.getItem("vs.ctab")) ? sessionStorage.getItem("vs.ctab") : "overview";
  const rerender = () => navigate(location.hash);

  const picker = h("div", { class: "ctl" });
  if (current) {
    const versionKey = `vs.cver.${current.id}`;
    const selVersion = Number(sessionStorage.getItem(versionKey)) || current.latestVersion;
    picker.append(h("label", { for: "contract", class: "nomargin" }, "Contract"),
      h("select", { id: "contract", onchange: (e) => { sessionStorage.setItem("vs.contract", e.target.value); rerender(); } }, contracts.map((c) => h("option", { value: c.id, selected: c.id === current.id }, `${c.isSimulation ? "[SIM] " : ""}${c.id}`))),
      h("label", { for: "cversion", class: "nomargin" }, "Version"),
      h("select", { id: "cversion", onchange: (e) => { sessionStorage.setItem(versionKey, e.target.value); rerender(); } }, [...current.versions].reverse().map((v) => h("option", { value: v, selected: v === selVersion }, `v${v}${v === current.latestVersion ? " (latest)" : ""}`))));
  }
  root.append(h("div", { class: "topbar" }, h("h1", {}, "Cross-Surface Contracts"), picker));
  root.append(h("p", { class: "muted" }, "Checks that one Flagsmith experiment is implemented consistently across several application surfaces: same canonical subject, same assignment, a valid combination of feature values. Everything below is read from the VariantShield backend."));

  const editor = manifestEditor(rerender);
  if (!current) {
    root.append(h("div", { class: "card" }, h("h2", {}, "No contracts yet"), h("p", { class: "muted" }, "Register a contract manifest below, or run a labelled simulation scenario."), scenarioButtons(scen, rerender)), editor);
    return root;
  }

  const version = Number(sessionStorage.getItem(`vs.cver.${current.id}`)) || current.latestVersion;
  let rep;
  try { rep = await api("GET", `/api/contracts/${current.id}/report?version=${version}`); } catch (e) { root.append(errBox(e), editor); return root; }
  const findings = await api("GET", `/api/contracts/${current.id}/findings?version=${version}`).catch(() => ({ findings: [] }));
  const r = rep.report;

  root.append(h("div", { class: `banner ${rep.source === "simulation" ? "sim" : r.status === "CONTRACT_VALID" ? "ok" : r.status === "CONTRACT_VIOLATION" ? "bad" : "warn"}` },
    h("div", { class: "row" }, statusChip(r.status), r.primaryCode ? chip("BREACH", r.primaryCode) : null, simBadge(rep.source === "simulation"), chip("none", `v${r.version}`)),
    h("p", { class: "muted mt6" }, rep.source === "simulation" ? "SIMULATION: synthetic subjects and surfaces, never mixed with real contracts. The variant is a deterministic split, not a Flagsmith assignment." : "Live contract: observations come from real surfaces.")));

  const tabs = h("div", { class: "row tabs", role: "tablist" }, TABS.map(([k, label]) => h("button", { role: "tab", "aria-selected": String(k === tab), class: k === tab ? "primary" : "", onclick: () => { sessionStorage.setItem("vs.ctab", k); rerender(); } }, label)));
  root.append(tabs);
  const body = { overview: () => overview(rep, current, rerender, scen), matrix: () => matrix(rep), combinations: () => combinations(rep, findings.findings), drift: () => driftTab(rep, current), evidence: () => evidence(rep, findings.findings, current, version) }[tab]();
  root.append(body, editor);
  return root;
}

function scenarioButtons(scen, rerender) {
  if (!scen.enabled) return h("p", { class: "muted" }, "Simulation is disabled on this server.");
  return h("div", {}, h("p", { class: "muted" }, scen.label), h("div", { class: "row" }, scen.scenarios.map((s) => h("button", { title: s.description, onclick: async (ev) => {
    ev.target.disabled = true;
    try {
      const res = await api("POST", `/api/simulate/contract/${s.id}`, {});
      sessionStorage.setItem("vs.contract", "sim-checkout-journey"); sessionStorage.setItem("vs.cver.sim-checkout-journey", "1");
      toast(`${s.title}: expected ${res.expectedCode}, observed ${res.observedCode}${res.matched ? "" : " (MISMATCH)"}`);
      rerender();
    } catch (e) { toast(e.message); ev.target.disabled = false; }
  } }, `Simulate: ${s.title}`))));
}

function overview(rep, current, rerender, scen) {
  const r = rep.report, c = rep.contract;
  const counts = Object.fromEntries(["compliant", "violating", "incomplete", "no_data"].map((k) => [k, r.surfaces.filter((s) => s.status === k).length]));
  const root = h("div", { class: "grid" });
  const runCheck = h("button", { class: "primary", onclick: async (ev) => {
    ev.target.disabled = true;
    try { const res = await api("POST", `/api/contracts/${current.id}/check?version=${r.version}`, {}); toast(`Check complete: ${res.persisted.newFindings} new finding(s) recorded${res.flagsmith.verified ? `, ${res.flagsmith.subjectsChecked} subject(s) re-verified with Flagsmith` : ""}`); rerender(); }
    catch (e) { toast(e.message); ev.target.disabled = false; }
  } }, "Run check (re-verify with Flagsmith, record findings)");
  root.append(h("div", { class: "grid g3" },
    h("div", { class: "card" }, h("header", {}, h("h2", {}, c.id), chip("none", `v${c.version}`)), h("dl", { class: "kv" }, h("dt", {}, "Experiment"), h("dd", {}, c.experiment.key), h("dt", {}, "Assignment flag"), h("dd", {}, c.experiment.assignmentFlag), h("dt", {}, "Environment"), h("dd", {}, c.experiment.environment), h("dt", {}, "Env pinned"), h("dd", {}, c.experiment.environmentFingerprint ?? "no"), h("dt", {}, "Identity"), h("dd", {}, `${c.identity.strategy}${c.identity.requireSameSubject ? ", same subject required" : ""}`), h("dt", {}, "Variants"), h("dd", {}, Object.keys(c.variants).join(", ")))),
    h("div", { class: "card" }, h("header", {}, h("h2", {}, "Surfaces")), h("dl", { class: "kv" }, h("dt", {}, "Registered"), h("dd", {}, c.surfaces.length), h("dt", {}, "Compliant"), h("dd", {}, counts.compliant), h("dt", {}, "Violating"), h("dd", {}, counts.violating), h("dt", {}, "Incomplete"), h("dd", {}, counts.incomplete), h("dt", {}, "No data"), h("dd", {}, counts.no_data))),
    h("div", { class: "card" }, h("header", {}, h("h2", {}, "Observations")), h("dl", { class: "kv" }, h("dt", {}, "Latest"), h("dd", {}, fmtTime(r.latestObservationAtMs)), h("dt", {}, "Linked"), h("dd", {}, r.linkedObservations), h("dt", {}, "Unlinked identity"), h("dd", {}, r.unlinkedObservations), h("dt", {}, "Subjects"), h("dd", {}, r.subjects.length), h("dt", {}, "Window"), h("dd", {}, `${Math.round(c.freshness.correlationWindowSeconds / 60)} min`), h("dt", {}, "Freshness"), h("dd", {}, `${Math.round(c.freshness.maxAgeSeconds / 60)} min`)))));
  root.append(h("div", { class: "card" }, h("header", {}, h("h2", {}, "Registered surfaces"), runCheck),
    table(["Surface", "Domain", "Required", "Status", { label: "Subjects", num: true }, { label: "Errors", num: true }, { label: "Warnings", num: true }, "Last observation"],
      r.surfaces.map((s) => h("tr", {}, h("td", { class: "mono" }, s.id), h("td", {}, s.domain), h("td", {}, s.required ? "yes" : "optional"), h("td", {}, statusChip(s.status)), h("td", { class: "num" }, s.subjects), h("td", { class: "num" }, s.errors), h("td", { class: "num" }, s.warnings), h("td", {}, fmtTime(s.lastObservedAtMs)))))));
  r.notes.forEach((n) => root.append(h("p", { class: "muted" }, n)));
  root.append(h("div", { class: "card" }, h("header", {}, h("h2", {}, "Simulation scenarios")), scenarioButtons(scen, rerender)));
  return root;
}

const cellStatus = (cell) => {
  if (cell.codes.includes("ASSIGNMENT_MISMATCH")) return ["MISMATCH", "BREACH"];
  if (cell.codes.includes("ENVIRONMENT_MISMATCH")) return ["ENV MISMATCH", "BREACH"];
  if (cell.codes.includes("ASSIGNMENT_MISSING")) return ["NO ASSIGNMENT", "BREACH"];
  if (cell.state === "missing") return ["NOT REPORTED", "WARNING"];
  if (cell.state === "delayed") return ["PENDING", "none"];
  if (cell.codes.includes("UNKNOWN_VARIANT")) return ["UNKNOWN VARIANT", "BREACH"];
  return ["MATCH", "ok"];
};

function matrix(rep) {
  const r = rep.report;
  const root = h("div", { class: "grid" });
  if (r.unlinkedObservations) root.append(h("div", { class: "banner warn" }, `${r.unlinkedObservations} observation(s) carried no verifiable identity (IDENTITY_UNLINKED). They are excluded from this matrix and listed under Contract evidence; VariantShield never guesses a subject.`));
  if (!r.subjects.length) return h("div", { class: "card" }, "No correlated subjects yet. Surfaces must report observations with a verified identity token.");
  const bad = (row) => row.cells.some((c) => c.state === "violation" || c.codes.some((x) => ["ASSIGNMENT_MISMATCH", "ENVIRONMENT_MISMATCH"].includes(x)));
  const only = h("input", { type: "checkbox", id: "only-diff", checked: r.subjects.some(bad) });
  const detailHost = h("div", {});
  const tableHost = h("div", {});
  let selected = (r.subjects.find(bad) ?? r.subjects[0]).subjectRef;
  const draw = () => {
    const rows = r.subjects.filter((s) => !only.checked || bad(s)).slice(0, 60);
    tableHost.replaceChildren(table(["Subject", "Flagsmith now", ...r.surfaces.map((s) => s.id)], rows.map((row) => h("tr", { class: row.subjectRef === selected ? "sel" : "", onclick: () => { selected = row.subjectRef; draw(); } },
      h("td", { class: "mono" }, short(row.subjectRef)), h("td", { class: "mono" }, row.canonicalVariant === undefined ? "not checked" : row.canonicalVariant ?? "(none)"),
      r.surfaces.map((s) => { const cell = row.cells.find((c) => c.surfaceId === s.id); const [, cls] = cell ? cellStatus(cell) : ["", "none"]; return h("td", {}, cell && cell.variant ? chip(cls, cell.variant) : chip(cls, cell ? cellStatus(cell)[0] : "n/a")); }))),
      { empty: "No differences found among the subjects in the window." }));
    const row = r.subjects.find((x) => x.subjectRef === selected);
    detailHost.replaceChildren(row ? h("div", { class: "card" }, h("header", {}, h("h2", {}, "Surface assignment comparison"), h("span", { class: "mono muted" }, row.subjectRef)),
      table(["Surface", "Identity", "Environment", "Variant", "Assignment status", "Resolved features", "Other findings"], row.cells.map((cell) => { const [label, cls] = cellStatus(cell); const other = cell.codes.filter((c) => !["ASSIGNMENT_MISMATCH", "ENVIRONMENT_MISMATCH", "ASSIGNMENT_MISSING"].includes(c)); return h("tr", {}, h("td", { class: "mono" }, cell.surfaceId), h("td", { class: "mono" }, short(row.subjectRef)), h("td", {}, cell.environment ?? "–", cell.envFingerprint ? h("span", { class: "muted mono" }, ` ${cell.envFingerprint.slice(0, 6)}`) : null), h("td", { class: "mono" }, cell.variant ?? "–"), h("td", {}, chip(cls, label)), h("td", { class: "mono" }, Object.entries(cell.features).map(([k, v]) => `${k}=${v}`).join(", ") || "–"), h("td", {}, other.length ? other.map((c) => chip(cell.state === "violation" ? "BREACH" : "WARNING", c)) : "–")); })),
      h("p", { class: "muted" }, `Reference variant: ${row.referenceVariant ?? "undetermined"}. Flagsmith buckets each environment independently, so identical assignments are only expected within one environment and one stable configuration.`)) : null);
  };
  only.addEventListener("change", draw);
  root.append(h("div", { class: "card" }, h("header", {}, h("h2", {}, `Subjects (${r.subjects.length})`), h("label", { for: "only-diff", class: "row nomargin" }, only, " only subjects with differences")), tableHost), detailHost);
  draw();
  return root;
}

function combinations(rep, findings) {
  const m = rep.combinationMatrix, c = rep.contract;
  const root = h("div", { class: "grid" });
  const reporters = (f) => c.surfaces.filter((s) => s.features === null || s.features.includes(f)).map((s) => s.id).join(", ");
  root.append(h("div", { class: "card" }, h("header", {}, h("h2", {}, "Expected configuration per variant"), h("span", { class: "muted" }, "from the contract")),
    table(["Feature", ...m.variants, "Reported by"], m.features.map((f) => h("tr", {}, h("td", { class: "mono" }, f), m.variants.map((v) => h("td", { class: "mono" }, String(m.values[v][f]))), h("td", {}, reporters(f)))))));
  const violations = {};
  for (const f of rep.report.findings) { const id = f.evidence.constraintId; if (id) violations[id] = (violations[id] ?? 0) + 1; }
  root.append(h("div", { class: "card" }, h("header", {}, h("h2", {}, "Constraints")),
    table(["Rule", "When", "Requires", "Forbids", { label: "Violations now", num: true }], m.constraints.map((k) => h("tr", {}, h("td", { class: "mono" }, k.id), h("td", { class: "mono" }, fmtClause(k.when)), h("td", { class: "mono" }, fmtClause(k.requires)), h("td", { class: "mono" }, fmtClause(k.forbids)), h("td", { class: "num" }, violations[k.id] ?? 0))), { empty: "The contract defines no cross-feature constraints." })));
  root.append(h("div", { class: "card" }, h("header", {}, h("h2", {}, "Observed combinations"), h("span", { class: "muted" }, "what the surfaces actually resolved, grouped across subjects")),
    table(["Variant", "Resolved features", { label: "Subjects", num: true }, "Status", "Why"], rep.observedCombinations.map((o) => h("tr", {}, h("td", { class: "mono" }, o.variant ?? "–"), h("td", { class: "mono" }, Object.entries(o.features).map(([k, v]) => `${k}=${v}`).join("  ")), h("td", { class: "num" }, o.subjects), h("td", {}, statusChip(o.status)), h("td", {}, o.reasons.length ? h("ul", {}, o.reasons.slice(0, 4).map((x) => h("li", {}, x))) : "Matches the contract"))), { empty: "No observations yet." })));
  void findings;
  return root;
}
const fmtClause = (o) => (Object.keys(o).length ? Object.entries(o).map(([k, v]) => `${k}=${v.join("|")}`).join(", ") : "–");

function driftTab(rep, current) {
  const root = h("div", { class: "grid" });
  root.append(h("div", { class: "card" }, h("header", {}, h("h2", {}, "Contract versions"), h("span", { class: "muted" }, "published versions are immutable; history is never rewritten")),
    table(["Version", "Status"], [...rep.versions].reverse().map((v) => h("tr", {}, h("td", {}, `v${v}`), h("td", {}, v === current.latestVersion ? chip("ok", "latest") : chip("none", "historical")))))));
  root.append(h("div", { class: "card" }, h("header", {}, h("h2", {}, "Detected changes"), h("span", { class: "muted" }, "version changes, configuration changes, silent surfaces, changed assignments")),
    table(["Detected", "Attribute", "Previous", "Current", "Version", "Severity", "Affected surfaces", "Why it matters"], rep.drift.map((d) => h("tr", {}, h("td", {}, fmtTime(d.detectedAt)), h("td", { class: "mono" }, d.attribute), h("td", { class: "mono" }, trim(d.previous)), h("td", { class: "mono" }, trim(d.current)), h("td", {}, d.previousVersion === d.currentVersion ? `v${d.currentVersion}` : `v${d.previousVersion ?? "–"} → v${d.currentVersion}`), h("td", {}, sevChip(d.severity)), h("td", {}, d.affectedSurfaces.join(", ")), h("td", {}, d.message))), { empty: "No drift recorded. Register a new contract version or run a check to detect changes." })));
  return root;
}
const trim = (s) => (s === null || s === undefined ? "–" : String(s).length > 60 ? `${String(s).slice(0, 57)}…` : String(s));

function evidence(rep, history, current, version) {
  const root = h("div", { class: "grid" });
  const live = rep.report.findings.filter((f) => f.severity !== "info");
  const row = (f, ref) => h("tr", { class: "clickable", onclick: () => showEvidence(f, ref) }, h("td", {}, fmtTime(f.observedAt ?? f.observedAtMs ?? f.detectedAt)), h("td", { class: "mono" }, f.surfaceId ?? "(several)"), h("td", { class: "mono" }, short(f.subjectRef)), h("td", {}, `v${f.contractVersion}`), h("td", {}, chip(f.severity === "error" ? "BREACH" : "WARNING", f.code)), h("td", { class: "mono" }, f.actual), h("td", { class: "mono" }, f.expected), h("td", {}, sevChip(f.severity)), h("td", { class: "mono" }, ref));
  const heads = ["Timestamp", "Surface", "Identity", "Contract", "Finding", "Actual", "Expected", "Severity", "Evidence ref"];
  root.append(h("div", { class: "card" }, h("header", {}, h("h2", {}, `Current evaluation (${live.length})`), h("span", { class: "muted" }, "click a row for the full evidence")), table(heads, live.slice(0, 100).map((f) => row(f, "live")), { empty: "No findings in the current window." })));
  root.append(h("div", { class: "card" }, h("header", {}, h("h2", {}, `Recorded history for v${version} (${history.length})`), h("span", { class: "muted" }, "findings persisted by checks; kept when the contract changes")), table(heads, history.map((f) => row(f, f.evidenceRef)), { empty: "Nothing recorded yet. Run a check to keep these findings as history." })));
  void current;
  return root;
}

function showEvidence(f, ref) {
  const dlg = h("dialog", { "aria-label": "Finding evidence" }, h("h2", {}, f.code), h("p", {}, f.message),
    h("pre", { class: "mono pre" }, JSON.stringify({ evidenceRef: ref, severity: f.severity, surface: f.surfaceId, subject: f.subjectRef, contractVersion: f.contractVersion, expected: f.expected, actual: f.actual, evidence: f.evidence }, null, 2)),
    h("button", { onclick: () => dlg.close() }, "Close"));
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}

function manifestEditor(rerender) {
  const ta = h("textarea", { id: "manifest", class: "manifest", "aria-label": "Contract manifest (YAML or JSON)", placeholder: "Paste a contract manifest (YAML or JSON)" });
  const out = h("div", { "aria-live": "polite" });
  const text = () => ta.value;
  const validate = async () => {
    try {
      const v = await api("POST", "/api/contracts/validate", { yaml: text() });
      out.replaceChildren(v.valid ? h("div", { class: "banner ok" }, `Valid: ${v.contract.id} v${v.contract.version}, ${v.contract.surfaces.length} surfaces, ${Object.keys(v.contract.variants).length} variants.${v.issues.length ? ` ${v.issues.length} warning(s).` : ""}`, v.issues.length ? h("ul", {}, v.issues.map((i) => h("li", {}, `${i.path}: ${i.message}`))) : null) : h("div", { class: "banner bad", role: "alert" }, `${v.issues.filter((i) => i.severity === "error").length} problem(s):`, h("ul", {}, v.issues.map((i) => h("li", {}, h("span", { class: "mono" }, i.path), `: ${i.message}`)))));
      return v;
    } catch (e) { out.replaceChildren(errBox(e)); return null; }
  };
  return h("details", { class: "card" }, h("summary", {}, "Contract manifest editor (validate and register)"),
    h("div", { class: "row mt10" },
      h("button", { onclick: async () => { try { ta.value = (await api("GET", "/api/contract-example")).yaml; } catch (e) { toast(e.message); } } }, "Load example"),
      h("button", { onclick: validate }, "Validate"),
      h("button", { class: "primary", onclick: async () => {
        const v = await validate();
        if (!v || !v.valid) return;
        try { const r = await api("POST", "/api/contracts", { yaml: text() }); toast(`${r.status === "created" ? "Registered" : "Unchanged"}: ${v.contract.id} v${v.contract.version}; ${r.drift.length} change(s) vs the previous version`); sessionStorage.setItem("vs.contract", v.contract.id); sessionStorage.removeItem(`vs.cver.${v.contract.id}`); rerender(); }
        catch (e) { out.replaceChildren(errBox(e)); }
      } }, "Register version")),
    ta, out);
}
