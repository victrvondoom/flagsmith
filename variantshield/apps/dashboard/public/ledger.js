import { api, ApiError } from "./api.js";
import { chip, fmtTime, h, table, toast } from "./ui.js";

const errText = (e) => (e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));
const errBox = (e) => h("div", { class: "banner bad", role: "alert" }, errText(e));
const DECISIONS = ["ship", "hold", "pause", "rollback", "extend"];
const decisionClass = { ship: "ok", extend: "none", hold: "WARNING", pause: "BREACH", rollback: "BREACH" };
const simChip = (src) => (src === "simulation" ? chip("SIMULATION", "SIM") : null);
const jsonShort = (v) => (typeof v === "string" ? v : JSON.stringify(v));
const KEY = "vs.lscope";
// Simulated plan titles already say SIMULATION; do not stack a second tag in front.
const simLabel = (isSim, text) => (isSim && !/simulation/i.test(text) ? `[SIM] ${text}` : text);

function readScope(plans, contracts) {
  let saved = ""; try { saved = sessionStorage.getItem(KEY) || ""; } catch { /* storage unavailable */ }
  const [t, id] = saved.split(":");
  if (t === "plan" && plans.some((p) => String(p.id) === id)) return { type: "plan", id };
  if (t === "contract" && contracts.some((c) => c.id === id)) return { type: "contract", id };
  if (plans[0]) return { type: "plan", id: String(plans[0].id) };
  if (contracts[0]) return { type: "contract", id: contracts[0].id };
  return null;
}

export async function ledgerView({ navigate }) {
  const [{ plans }, { contracts }] = await Promise.all([api("GET", "/api/plans"), api("GET", "/api/contracts")]);
  const root = h("div", { class: "grid" });
  const scope = readScope(plans, contracts);
  const rerender = () => navigate(location.hash);
  root.append(h("div", { class: "topbar" }, h("h1", {}, "Decision Ledger"),
    scope ? h("div", { class: "ctl" }, h("label", { for: "lscope", class: "nomargin" }, "Experiment or contract"),
      h("select", { id: "lscope", onchange: (e) => { try { sessionStorage.setItem(KEY, e.target.value); } catch { /* storage unavailable */ } rerender(); } },
        plans.length ? h("optgroup", { label: "Experiment plans" }, plans.map((p) => h("option", { value: `plan:${p.id}`, selected: scope.type === "plan" && scope.id === String(p.id) }, simLabel(p.isSimulation, p.title)))) : null,
        contracts.length ? h("optgroup", { label: "Cross-surface contracts" }, contracts.map((c) => h("option", { value: `contract:${c.id}`, selected: scope.type === "contract" && scope.id === c.id }, simLabel(c.isSimulation, c.id)))) : null)) : null));
  root.append(h("p", { class: "muted" }, "The preserved record of what was known and who decided what. Entries cannot be edited or deleted, each is chained to the one before and signed by the server. A decision is official only after a different person approves it. The assistant answers from these records with citations; it is rule-based, not a language model, and it cannot record or approve anything."));
  if (!scope) { root.append(h("div", { class: "card" }, h("h2", {}, "Nothing to record yet"), h("p", { class: "muted" }, "Create an experiment plan or register a contract first (Command Center runs a simulation in one click)."))); return root; }

  let brief, entries;
  try {
    [{ brief }, { entries }] = await Promise.all([api("GET", `/api/context/${scope.type}/${scope.id}`), api("GET", `/api/ledger?subjectType=${scope.type}&subjectId=${encodeURIComponent(scope.id)}&limit=60`)]);
  } catch (e) { root.append(errBox(e)); return root; }

  /* ---- integrity ---- */
  const integrity = h("div", { class: "row", id: "integrity" });
  const paintIntegrity = (v) => integrity.replaceChildren(
    chip(v.ok ? "ok" : "BREACH", v.ok ? "LEDGER VERIFIED" : "LEDGER FAILED VERIFICATION"),
    h("span", { class: "muted" }, v.ok ? ` ${v.entries} entries, head ${(v.head ?? "(empty)").slice(0, 12)}` : ` entry ${v.firstBadSeq}: ${v.reason}`),
    h("button", { type: "button", class: "ghost", onclick: async () => { try { paintIntegrity(await api("GET", "/api/ledger/verify")); } catch (e) { toast(errText(e)); } } }, "Verify now"));
  paintIntegrity({ ok: brief.integrity.ok, entries: brief.integrity.entries, head: brief.integrity.head, firstBadSeq: null, reason: brief.integrity.reason });
  root.append(integrity);

  /* ---- left column ---- */
  const left = h("div", { class: "grid" });
  const od = brief.officialDecision;
  left.append(h("div", { class: "card", id: "official" }, h("header", {}, h("h2", {}, "Official decision"), simChip(brief.source)),
    od ? h("div", {}, h("div", { class: "row" }, chip(decisionClass[od.decision] ?? "none", od.decision.toUpperCase()), h("span", { class: "muted" }, ` #${od.seq} proposed by ${od.proposedBy}, approved by ${od.approvedBy}, ${fmtTime(od.at)}`)), h("p", {}, od.rationale))
       : h("p", { class: "muted" }, "No official decision has been recorded. A proposal becomes official when a different person approves it.")));

  left.append(h("div", { class: "card", id: "pending" }, h("header", {}, h("h2", {}, "Awaiting approval")),
    brief.pendingProposals.length ? brief.pendingProposals.map((p) => h("div", { class: "row", style: null },
      chip(decisionClass[p.decision] ?? "none", p.decision.toUpperCase()), h("span", {}, ` #${p.seq} by ${p.proposedBy}: ${p.rationale}`), p.stale ? chip("WARNING", "FACTS CHANGED") : null,
      h("button", { type: "button", onclick: () => resolveDialog(p, "approve", rerender) }, "Approve…"), h("button", { type: "button", class: "ghost", onclick: () => resolveDialog(p, "reject", rerender) }, "Reject…")))
      : h("p", { class: "muted" }, "No proposals are waiting.")));

  left.append(h("div", { class: "card", id: "changes" }, h("header", {}, h("h2", {}, "Changed since the official decision")),
    !od ? h("p", { class: "muted" }, "There is no official decision to compare against.")
      : brief.changedSinceOfficialDecision.length ? table(["Fact", "Then", "Now"], brief.changedSinceOfficialDecision.map((c) => h("tr", {}, h("td", { class: "mono" }, c.field), h("td", {}, jsonShort(c.then)), h("td", {}, jsonShort(c.now)))))
      : h("p", { class: "muted" }, "Nothing a decision depends on has changed.")));

  left.append(h("div", { class: "card", id: "questions" }, h("header", {}, h("h2", {}, "Open questions")),
    brief.openQuestions.length ? h("ul", {}, brief.openQuestions.map((q) => h("li", {}, q))) : h("p", { class: "muted" }, "None.")));

  /* ---- record ---- */
  const decisionSel = h("select", { id: "decision" }, DECISIONS.map((d) => h("option", { value: d }, d)));
  const rationale = h("textarea", { id: "rationale", rows: 3, maxlength: 2000, placeholder: "Why? Say it for whoever reads this later (at least 10 characters)." });
  const noteBox = h("textarea", { id: "note", rows: 2, maxlength: 1000, placeholder: "A note for the record" });
  const submitProposal = async () => {
    try { await api("POST", "/api/ledger/decisions", { scope, decision: decisionSel.value, rationale: rationale.value }); toast("Proposal recorded. Another person must approve it."); rerender(); } catch (e) { toast(errText(e)); }
  };
  left.append(h("div", { class: "card", id: "record" }, h("header", {}, h("h2", {}, "Record")),
    h("label", { for: "decision" }, "Propose a decision"), h("div", { class: "row" }, decisionSel), h("label", { for: "rationale" }, "Rationale"), rationale,
    h("div", { class: "row" }, h("button", { type: "button", id: "propose", onclick: submitProposal }, "Propose decision")),
    h("label", { for: "note" }, "Add a note"), noteBox,
    h("div", { class: "row" }, h("button", { type: "button", class: "ghost", id: "add-note", onclick: async () => { try { await api("POST", "/api/ledger/notes", { scope, text: noteBox.value }); toast("Note recorded."); rerender(); } catch (e) { toast(errText(e)); } } }, "Add note"))));

  /* ---- timeline ---- */
  left.append(h("div", { class: "card", id: "timeline" }, h("header", {}, h("h2", {}, `Ledger entries (${entries.length})`), h("a", { href: `#/ledger`, class: "muted", onclick: (e) => { e.preventDefault(); exportJson(scope); } }, "Export JSON")),
    table(["#", "When", "Kind", "By", "Summary"], entries.map((e) => h("tr", {}, h("td", { class: "mono" }, e.seq), h("td", {}, fmtTime(e.ts)), h("td", {}, chip(e.kind.startsWith("decision.approved") ? "ok" : e.kind.startsWith("decision.rejected") ? "BREACH" : "none", e.kind), simChip(e.source)), h("td", {}, e.actor), h("td", {}, e.summary))), { empty: "No entries for this subject yet." })));

  /* ---- assistant ---- */
  const log = h("div", { class: "answers", role: "log", "aria-live": "polite", "aria-label": "Assistant answers" });
  const question = h("input", { id: "question", maxlength: 400, placeholder: "Ask about this experiment…", autocomplete: "off" });
  const chips = h("div", { class: "row wrap", id: "suggestions" });
  const useDraft = (d) => { decisionSel.value = d.decision; rationale.value = d.rationale; rationale.scrollIntoView({ block: "center" }); rationale.focus(); };
  const ask = async (q) => {
    const text = (q ?? question.value).trim(); if (!text) return;
    question.value = "";
    const pending = h("div", { class: "answer muted" }, `Asking: ${text}`);
    log.prepend(pending);
    try {
      const { answer } = await api("POST", "/api/assistant/ask", { scope, question: text });
      pending.className = "answer";
      pending.replaceChildren(h("div", { class: "q" }, text), h("div", { class: "a" }, answer.lines.map((l) => h("p", {}, l))),
        answer.citations.length ? h("div", { class: "row wrap cites" }, answer.citations.map((c) => h("span", { class: "chip s-none", title: c.type }, `${c.type}: ${c.ref}`))) : null,
        answer.draft ? h("div", { class: "draft" }, h("strong", {}, `Draft: ${answer.draft.decision.toUpperCase()}`), h("p", {}, answer.draft.rationale), h("button", { type: "button", class: "ghost", onclick: () => useDraft(answer.draft) }, "Use as proposal")) : null);
      chips.replaceChildren(...answer.suggestions.map((s) => h("button", { type: "button", class: "ghost chipbtn", onclick: () => ask(s) }, s)));
    } catch (e) { pending.className = "answer"; pending.replaceChildren(errBox(e)); }
  };
  chips.replaceChildren(...["What is the current status?", "Should we ship this?", "What changed since the last decision?", "What are the open risks?"].map((s) => h("button", { type: "button", class: "ghost chipbtn", onclick: () => ask(s) }, s)));
  const right = h("div", { class: "card sticky", id: "assistant" }, h("header", {}, h("h2", {}, "Assistant"), chip("none", "RULE-BASED")),
    h("p", { class: "muted" }, "Answers come from the records on this page, with citations. It can draft a decision for you to record; it cannot record or approve one."),
    h("label", { for: "question" }, "Question"), h("div", { class: "row" }, question, h("button", { type: "button", id: "ask", onclick: () => ask() }, "Ask")), chips, log);
  question.addEventListener("keydown", (e) => { if (e.key === "Enter") ask(); });

  root.append(h("div", { class: "split" }, left, right));
  return root;
}

async function exportJson(scope) {
  try {
    const data = await api("GET", `/api/ledger/export?subjectType=${scope.type}&subjectId=${encodeURIComponent(scope.id)}`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = h("a", { href: url, download: `ledger-${scope.type}-${scope.id}.json` }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { toast(errText(e)); }
}

function resolveDialog(p, action, rerender) {
  const word = action.toUpperCase();
  const confirm = h("input", { id: "confirm", autocomplete: "off", placeholder: `${word} ${p.seq}`, "aria-label": `Type ${word} ${p.seq} to confirm` });
  const reason = h("textarea", { id: "reason", rows: 2, maxlength: 500, placeholder: "Reason (at least 5 characters)" });
  const ack = h("input", { type: "checkbox", id: "ack" });
  const ackRow = h("label", { for: "ack", class: "row nomargin", hidden: true }, ack, " I have reviewed the changes and still approve");
  const changes = h("div", {});
  const status = h("div", { role: "alert" });
  const submit = h("button", { type: "button", id: "resolve", onclick: async () => {
    try {
      await api("POST", `/api/ledger/decisions/${p.seq}/resolve`, { action, confirmation: confirm.value, reason: reason.value, acknowledgeChanges: ack.checked });
      dlg.close(); toast(action === "approve" ? "Decision is now official." : "Proposal rejected."); rerender();
    } catch (e) {
      status.replaceChildren(errBox(e));
      if (e instanceof ApiError && e.code === "context_changed") {
        ackRow.hidden = false; ackRow.removeAttribute("hidden");
        const list = e.detail?.changes ?? [];
        changes.replaceChildren(h("p", {}, "The facts this decision was based on have changed:"), table(["Fact", "Then", "Now"], list.map((c) => h("tr", {}, h("td", { class: "mono" }, c.field), h("td", {}, jsonShort(c.then)), h("td", {}, jsonShort(c.now))))));
      }
    }
  } }, `${action === "approve" ? "Approve" : "Reject"} decision`);
  const dlg = h("dialog", { "aria-label": `${action === "approve" ? "Approve" : "Reject"} decision ${p.seq}` },
    h("h2", {}, `${action === "approve" ? "Approve" : "Reject"} #${p.seq}: ${p.decision.toUpperCase()}`), h("p", {}, p.rationale),
    h("p", { class: "muted" }, `Proposed by ${p.proposedBy}. ${action === "approve" ? "Approving makes it the official decision. You cannot approve your own proposal (use another actor name)." : "The proposal stays in the ledger as rejected."}`),
    changes, ackRow, h("label", { for: "confirm" }, `Type ${word} ${p.seq} to confirm`), confirm, h("label", { for: "reason" }, "Reason"), reason, status,
    h("div", { class: "row" }, submit, h("button", { type: "button", class: "ghost", onclick: () => dlg.close() }, "Cancel")));
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}
