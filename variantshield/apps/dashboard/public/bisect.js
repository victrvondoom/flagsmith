// Incident Room: the bisection swarm, live. Every number on this page comes from /api/incidents/:id; the page re-reads it
// whenever the server streams an event, so nothing here is static or remembered client-side.
import { api, stream } from "./api.js";
import { chip, h, toast } from "./ui.js";

const SVGNS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}, ...kids) => { const el = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v)); for (const kid of kids.flat()) if (kid) el.append(kid); return el; };
const pct = (x, d = 2) => (x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(d)}%`);
const clock = (ms) => (ms ? new Date(ms).toISOString().slice(11, 19) : "n/a");
const val = (v) => (!v ? "n/a" : v.enabled ? (v.value === null || v.value === "" ? "on" : `on · ${v.value}`) : "off");
const ago = (from, to) => { const m = Math.round((to - from) / 60000); return m >= 0 ? `${m} min before onset` : `${-m} min after onset`; };
const KEY = "vs.incident";
const remember = (id) => { try { sessionStorage.setItem(KEY, String(id)); } catch { /* storage unavailable */ } };
const recall = () => { try { return Number(sessionStorage.getItem(KEY) || 0); } catch { return 0; } };

export async function incidentRoom(ctx) {
  const [swarm, list] = await Promise.all([api("GET", "/api/swarm"), api("GET", "/api/incidents")]);
  let incidents = list.incidents;
  let current = incidents.find((i) => i.id === recall())?.id ?? incidents[0]?.id ?? 0;
  const root = h("div", { class: "room" });
  const live = h("span", { class: "live", "data-state": "connecting", role: "status", "aria-live": "polite" }, "Connecting");
  const picker = h("select", { id: "incident-pick", "aria-label": "Incident" });
  const body = h("div", { class: "room-body" });
  let gateKey = "", gates = h("div");
  let feedEl = null;

  const fillPicker = () => {
    picker.replaceChildren(...(incidents.length ? incidents.map((i) => h("option", { value: i.id, selected: i.id === current }, `#${i.id} ${i.source === "simulation" ? "[SIM] " : ""}${i.state.replaceAll("_", " ")} · ${i.suspects} suspects`)) : [h("option", { value: "" }, "No incidents yet")]));
    picker.disabled = !incidents.length;
  };
  picker.addEventListener("change", () => { current = Number(picker.value); remember(current); gateKey = ""; void refresh(); });
  fillPicker();

  const scenarioButtons = swarm.demoMode ? swarm.scenarios.map((s) => h("button", { class: "ghost", title: s.description, onclick: async () => {
    try { await api("POST", "/api/incidents/simulate", { scenario: s.id }); toast(`Simulation started: ${s.title}. The Sentinel is watching.`); } catch (e) { toast(e.message); }
  } }, `Simulate: ${s.title}`)) : [];

  const header = h("div", { class: "topbar" },
    h("div", {}, h("h1", {}, "Incident Room"), h("p", { class: "muted sub" }, "A regression followed several flag changes. The swarm finds the one that caused it by reverting subsets for a small canary cohort only, and stops for people at the two points that matter.")),
    h("div", { class: "ctl" }, live, picker));
  const sims = scenarioButtons.length ? h("div", { class: "row sims" }, h("span", { class: "muted" }, "Rehearse:"), scenarioButtons, h("span", { class: "chip s-SIM" }, "SIMULATION runs in-process, never touches Flagsmith")) : null;
  const wiring = h("div", { class: "row muted small" },
    swarm.flagsmith ? [chip("ok", "Flagsmith connected"), h("span", { class: "mono" }, `${swarm.flagsmith.baseUrl} · env ${swarm.flagsmith.environmentKey}`)] : chip("none", "Flagsmith not configured: real incidents disabled"),
    swarm.webhook.secretConfigured ? chip("ok", "webhook secret set (signatures checked)") : chip("pending", "flag changes: watcher every 5 s (set VARIANTSHIELD_FLAGSMITH_WEBHOOK_SECRET to also accept signed webhooks)"));
  root.append(header, sims, wiring, body);

  let timer = null;
  const schedule = () => { if (timer) return; timer = setTimeout(() => { timer = null; void refresh(); }, 700); };

  async function refresh() {
    try {
      const l = await api("GET", "/api/incidents");
      incidents = l.incidents;
      if (!incidents.some((i) => i.id === current)) current = incidents[0]?.id ?? 0;
      fillPicker();
      if (!current) { body.replaceChildren(empty(swarm)); return; }
      const { incident } = await api("GET", `/api/incidents/${current}`);
      draw(incident);
    } catch (e) { body.replaceChildren(h("div", { class: "banner bad", role: "alert" }, `Could not load the incident: ${e.message}`)); }
  }

  function draw(inc) {
    const k = `${inc.id}:${inc.state}:${inc.remediation?.proposedBy ?? ""}`;
    if (k !== gateKey) { gateKey = k; gates = gatePanel(inc, refresh); }
    const keepScroll = feedEl && feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 40;
    feedEl = feed(inc);
    body.replaceChildren(
      hero(inc),
      h("div", { class: "room-grid" },
        h("div", { class: "stack" }, rateChart(inc), suspects(inc), probes(inc)),
        h("div", { class: "stack" }, gates, agents(inc), hypotheses(inc), h("section", { class: "card" }, h("header", {}, h("h2", {}, "Swarm feed"), h("span", { class: "muted small" }, `${inc.messages.length} messages`)), feedEl))));
    if (keepScroll !== false) feedEl.scrollTop = feedEl.scrollHeight;
  }

  const stop = stream("/api/stream", (name) => { if (name === "message" || name === "incident" || name === "tick") schedule(); }, (s) => { live.dataset.state = s; live.textContent = s === "live" ? "Live" : s === "reconnecting" ? "Reconnecting" : "Offline"; });
  ctx.onLeave(() => { stop(); if (timer) clearTimeout(timer); });
  await refresh();
  return root;
}

function empty(swarm) {
  return h("section", { class: "card hero-empty" },
    h("h2", {}, "No incidents"), h("p", { class: "muted" }, "The Sentinel opens an incident when the failure rate your apps report (POST /api/bisect/signals) shifts. Until then there is nothing to bisect."),
    h("ol", { class: "steps" }, swarm.agents.map((a) => h("li", {}, h("strong", {}, a.name), ` ${a.role}`))));
}

function hero(inc) {
  const tone = { RESOLVED: "ok", REMEDIATED: "ok", IDENTIFIED: "warn", NOT_A_FLAG_CHANGE: "info", ABORTED: "bad", INCONCLUSIVE: "info" }[inc.state] ?? "bad";
  const culprit = inc.conclusion && inc.conclusion.ids.length ? inc.conclusion.ids.map((id) => inc.suspects.find((s) => s.id === id)?.feature ?? id).join(" + ") : null;
  return h("section", { class: `hero tone-${tone}`, "aria-label": "Incident summary" },
    h("div", { class: "hero-main" },
      h("div", { class: "row" }, chip(inc.state, inc.state.replaceAll("_", " ")), inc.simulated ? chip("SIM", "SIMULATION") : chip("ok", "REAL"), h("span", { class: "muted mono" }, `incident #${inc.id} · clock ${clock(inc.clock)}`)),
      h("div", { class: "headline" }, culprit ? h("span", {}, "Culprit: ", h("b", {}, culprit), h("span", { class: "muted" }, ` (${pct(inc.conclusion.confidence, 1)}${inc.confirmed ? ", confirmed by a canary revert" : ""})`)) : inc.state === "NOT_A_FLAG_CHANGE" ? "None of these flag changes caused it." : `Failure rate ${pct(inc.baselineRate)} → ${pct(inc.regressionRate)}`),
      inc.waitingOn ? h("p", { class: "waiting" }, h("span", { class: "pulse" }), `Waiting on ${inc.waitingOn}`) : null),
    h("dl", { class: "stats" },
      stat("Onset", clock(inc.onsetAt)), stat("Baseline", pct(inc.baselineRate)), stat("During incident", pct(inc.regressionRate)), stat("Suspects", String(inc.suspects.length)),
      stat("Rounds", inc.envelope ? `${inc.rounds} / ${inc.envelope.maxRounds}` : String(inc.rounds)), stat("Canary", inc.envelope ? `${inc.envelope.canaryPercent}%` : "none")));
}
const stat = (k, v) => h("div", {}, h("dt", {}, k), h("dd", {}, v));

function rateChart(inc) {
  const W = 640, H = 200, P = { l: 44, r: 10, t: 12, b: 24 };
  const pts = inc.series.filter((b) => b.n > 0);
  const card = h("section", { class: "card chart" }, h("header", {}, h("h2", {}, "Failure rate per minute"), h("span", { class: "legend" }, h("span", {}, h("span", { class: "swatch s1" }), " all traffic"), h("span", {}, h("span", { class: "swatch onset" }), " onset"), h("span", {}, h("span", { class: "swatch probe" }), " probe window"))));
  if (pts.length < 2) { card.append(h("p", { class: "muted" }, "Waiting for traffic.")); return card; }
  const x0 = pts[0].start, x1 = pts[pts.length - 1].start + 60000;
  const ymax = Math.max(0.02, ...pts.map((p) => p.failures / p.n)) * 1.15;
  const X = (t) => P.l + ((t - x0) / (x1 - x0)) * (W - P.l - P.r), Y = (v) => H - P.b - (v / ymax) * (H - P.t - P.b);
  const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img", "aria-label": `Failure rate per minute, ${pct(inc.baselineRate)} before the onset and ${pct(inc.regressionRate)} after` });
  for (let i = 0; i <= 4; i++) { const v = (ymax / 4) * i; g.append(svg("line", { x1: P.l, x2: W - P.r, y1: Y(v), y2: Y(v), class: "grid-line" }), svg("text", { x: P.l - 6, y: Y(v) + 3, "text-anchor": "end", class: "axis" }, document.createTextNode(`${(v * 100).toFixed(1)}%`))); }
  for (const p of inc.probes) { const a = Math.max(x0, p.startedAt), b = Math.min(x1, p.endedAt ?? inc.clock); if (b > a) g.append(svg("rect", { x: X(a), y: P.t, width: Math.max(1, X(b) - X(a)), height: H - P.t - P.b, class: `probe-band v-${p.verdict ?? "running"}` })); }
  if (inc.onsetAt) g.append(svg("line", { x1: X(inc.onsetAt), x2: X(inc.onsetAt), y1: P.t, y2: H - P.b, class: "onset-line" }));
  const path = pts.map((p, i) => `${i ? "L" : "M"}${X(p.start + 30000).toFixed(1)},${Y(p.failures / p.n).toFixed(1)}`).join(" ");
  g.append(svg("path", { d: `${path} L${X(pts[pts.length - 1].start + 30000)},${Y(0)} L${X(pts[0].start + 30000)},${Y(0)} Z`, class: "area" }), svg("path", { d: path, class: "line s1" }));
  for (const t of [x0, (x0 + x1) / 2, x1]) g.append(svg("text", { x: X(t), y: H - 6, "text-anchor": "middle", class: "axis" }, document.createTextNode(clock(t))));
  card.append(g);
  return card;
}

function suspects(inc) {
  const rows = [...inc.suspects].sort((a, b) => b.involvement - a.involvement || a.changedAt - b.changedAt);
  return h("section", { class: "card" }, h("header", {}, h("h2", {}, "Suspects"), h("span", { class: "muted small" }, "prior from evidence → posterior after each probe")),
    rows.length ? h("div", { class: "suspects" }, rows.map((s) => h("div", { class: `suspect${s.reverted ? " reverted" : ""}${inc.conclusion?.ids.includes(s.id) ? " culprit" : ""}` },
      h("div", { class: "s-name" }, h("b", { class: "mono" }, s.feature), s.reverted ? chip("pending", "reverted in canary") : null, inc.conclusion?.ids.includes(s.id) ? chip("BREACH", "culprit") : null),
      h("div", { class: "s-change mono" }, `${val(s.before)} → ${val(s.after)}`),
      h("div", { class: "s-meta muted" }, `${s.changedBy} · ${inc.onsetAt ? ago(s.changedAt, inc.onsetAt) : clock(s.changedAt)}`),
      meter("prior", s.prior, "base"), meter("posterior", s.involvement, "")))) : h("p", { class: "muted" }, "The Archivist has not collected the changes yet."));
}
function meter(label, p, cls) {
  const fill = h("span", { class: `fill ${cls}` });
  fill.style.width = `${Math.max(0, Math.min(100, p * 100)).toFixed(1)}%`;
  return h("div", { class: "meter", "aria-label": `${label} ${pct(p, 1)}` }, h("span", { class: "m-l" }, label), h("span", { class: "track" }, fill), h("span", { class: "m-v mono" }, pct(p, 1)));
}

function hypotheses(inc) {
  return h("section", { class: "card" }, h("header", {}, h("h2", {}, "Leading explanations"), h("span", { class: "muted small" }, "single changes, pairs, or none")),
    inc.hypotheses.length ? inc.hypotheses.map((x) => meter(x.label, x.p, x.kind === "none" ? "base" : x.kind === "pair" ? "pair" : "")) : h("p", { class: "muted" }, "No odds yet."));
}

function probes(inc) {
  const rows = inc.probes.map((p) => {
    const j = p.judgement;
    return h("li", { class: `probe v-${p.verdict ?? "running"}` },
      h("div", { class: "p-head" }, h("b", {}, `Round ${p.round}`), p.verdict ? chip(p.verdict === "healed" ? "ok" : p.verdict === "not_healed" ? "none" : "BREACH", p.verdict.replace("_", " ")) : chip("pending", "measuring"),
        h("span", { class: "muted mono" }, `${clock(p.startedAt)}${p.endedAt ? ` – ${clock(p.endedAt)}` : ""}`)),
      h("div", { class: "p-revert" }, "Reverted for the canary: ", p.revert.map((id) => h("span", { class: "tag mono" }, inc.suspects.find((s) => s.id === id)?.feature ?? id))),
      j ? h("div", { class: "p-num mono" }, `canary ${pct(j.canaryRate)} · main ${pct(j.mainRate)} · recovered ${Math.round((j.recovered ?? 0) * 100)}% · evidence ${j.evidence >= 1000 ? j.evidence.toExponential(1) : (j.evidence ?? 0).toFixed(1)} / ${j.threshold}`) : null);
  });
  const live = inc.activeProbe && inc.lastJudgement ? h("p", { class: "muted small" }, `Judge, now: ${inc.lastJudgement.reason}`) : null;
  return h("section", { class: "card" }, h("header", {}, h("h2", {}, "Probes"), h("span", { class: "muted small" }, inc.canary ? inc.canary.label : "no canary active")), live, rows.length ? h("ol", { class: "probes" }, rows) : h("p", { class: "muted" }, "No probes yet. Each one needs the approved envelope."));
}

function agents(inc) {
  return h("section", { class: "card" }, h("header", {}, h("h2", {}, "Swarm"), h("span", { class: "muted small" }, "deterministic agents, one job each")),
    h("ul", { class: "agents" }, inc.agents.map((a) => h("li", { class: `agent a-${a.status}` }, h("div", { class: "a-head" }, h("span", { class: "a-dot", "aria-hidden": "true" }), h("b", {}, a.name), h("span", { class: "muted small" }, a.status)), h("div", { class: "small muted" }, a.last ?? a.role)))));
}

function feed(inc) {
  return h("ol", { class: "feed", "aria-label": "Swarm messages" }, inc.messages.map((m) => h("li", { class: `msg m-${m.agent}` }, h("span", { class: "mono t" }, clock(m.ts)), h("b", { class: "who" }, m.agent), h("span", { class: "txt" }, m.text))));
}

function gatePanel(inc, refresh) {
  const box = h("section", { class: "card gate", "aria-label": "Human decisions" });
  const add = (...kids) => box.append(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
  const err = h("div", { role: "alert", class: "small bad-text" });
  const submit = async (fn) => { err.textContent = ""; try { await fn(); toast("Recorded in the decision ledger."); await refresh(); } catch (e) { err.textContent = `${e.code ?? "error"}: ${e.message}`; } };
  if (inc.state === "AWAITING_APPROVAL" && inc.envelope) {
    const conf = h("input", { id: "env-confirm", autocomplete: "off", placeholder: inc.confirmations.envelope });
    const reason = h("input", { id: "env-reason", placeholder: "Why you approve this" });
    const canary = h("input", { id: "env-canary", type: "number", min: 1, max: 20, value: inc.envelope.canaryPercent });
    add(h("header", {}, h("h2", {}, "Approve the envelope"), chip("pending", "gate 1 of 2")),
      h("p", { class: "small" }, `Inside this envelope the swarm may revert any of ${inc.envelope.suspects.length} changes for ${inc.envelope.canaryPercent}% of identities only, for at most ${inc.envelope.maxRounds} rounds and ${inc.envelope.maxMinutes} minutes. Everyone else keeps today's flags. Nothing has been changed yet.`),
      h("label", { for: "env-canary" }, "Canary size (% of identities, 1 to 20)"), canary, h("label", { for: "env-reason" }, "Reason"), reason,
      h("label", { for: "env-confirm" }, `Type ${inc.confirmations.envelope} to confirm`), conf,
      h("div", { class: "row mt10" }, h("button", { class: "primary", onclick: () => submit(() => api("POST", `/api/incidents/${inc.id}/envelope`, { confirmation: conf.value.trim(), reason: reason.value, canaryPercent: Number(canary.value) })) }, "Approve and start probing"),
        h("button", { class: "ghost", onclick: () => submit(() => api("POST", `/api/incidents/${inc.id}/abort`, { reason: reason.value || "Declined the envelope" })) }, "Decline")), err);
  } else if (inc.state === "IDENTIFIED" && inc.remediation) {
    const reason = h("input", { id: "rem-reason", placeholder: "Rationale for whoever reads this later" });
    add(h("header", {}, h("h2", {}, "Propose the remediation"), chip("pending", "gate 2 of 2")),
      h("p", { class: "small" }, "Draft from the Scribe: restore ", inc.remediation.restore.map((r) => h("span", { class: "tag mono" }, `${r.feature} → ${val(r.to)}`)), " for everyone in the environment. A different person must approve it."),
      h("label", { for: "rem-reason" }, "Rationale"), reason,
      h("div", { class: "row mt10" }, h("button", { class: "primary", onclick: () => submit(() => api("POST", `/api/incidents/${inc.id}/remediation`, { action: "propose", reason: reason.value })) }, "Propose remediation")), err);
  } else if (inc.state === "REMEDIATION_PROPOSED" && inc.remediation) {
    const conf = h("input", { id: "rem-confirm", autocomplete: "off", placeholder: inc.confirmations.remediation });
    const reason = h("input", { id: "rem-approve-reason", placeholder: "What you checked" });
    add(h("header", {}, h("h2", {}, "Second-person approval"), chip("pending", "gate 2 of 2")),
      h("p", { class: "small" }, `Proposed by ${inc.remediation.proposedBy}. Approving as the same person is refused. This changes Flagsmith for everyone and is then read back.`),
      h("label", { for: "rem-approve-reason" }, "Reason"), reason, h("label", { for: "rem-confirm" }, `Type ${inc.confirmations.remediation} to confirm`), conf,
      h("div", { class: "row mt10" }, h("button", { class: "danger", onclick: () => submit(() => api("POST", `/api/incidents/${inc.id}/remediation`, { action: "approve", confirmation: conf.value.trim(), reason: reason.value })) }, "Approve and apply")), err);
  } else {
    const done = { RESOLVED: "Resolved: the failure rate is back to baseline.", REMEDIATED: "Remediated and read back. The Sentinel is waiting for the failure rate to recover.", NOT_A_FLAG_CHANGE: "Closed: not caused by these flag changes. The canary was removed.", ABORTED: "Stopped. The canary was removed.", INCONCLUSIVE: "Inconclusive within the envelope. The canary was removed." }[inc.state];
    add(h("header", {}, h("h2", {}, "Human decisions")), h("p", { class: "small" }, done ?? "The swarm is working inside the approved envelope. You can stop it at any time."),
      inc.envelopeApproval ? h("p", { class: "small muted" }, `Envelope approved by ${inc.envelopeApproval.actor} (ledger #${inc.envelopeApproval.seq}).`) : null,
      inc.remediation?.approvedBy ? h("p", { class: "small muted" }, `Remediation proposed by ${inc.remediation.proposedBy}, approved by ${inc.remediation.approvedBy}.`) : null,
      ["PROBING", "CONFIRMING", "INVESTIGATING"].includes(inc.state) ? h("button", { class: "ghost", onclick: () => submit(() => api("POST", `/api/incidents/${inc.id}/abort`, { reason: "Stopped from the Incident Room" })) }, "Stop the swarm") : null, err);
  }
  return box;
}
