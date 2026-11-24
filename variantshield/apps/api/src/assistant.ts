import type { Brief } from "./briefing.ts";
import { DECISIONS, type Decision } from "./ledger.ts";

/**
 * Rule-based assistant. No model, no network: it classifies the question with fixed patterns and answers from the
 * briefing only. Every statement carries a citation to the record it came from. It can draft a decision for a human to
 * record; it cannot record, approve, pause or change anything.
 */

export type Intent = "help" | "status" | "why" | "changes" | "recommend" | "decision" | "risks" | "integrity" | "history" | "explain" | "unknown";
export interface Citation { type: "ledger" | "finding" | "evidence" | "fact" | "contract"; ref: string }
export interface Draft { decision: Decision; rationale: string }
export interface Answer { intent: Intent; answer: string; lines: string[]; citations: Citation[]; suggestions: string[]; draft: Draft | null; basedOn: { fingerprint: string; generatedAt: number } }

export const MAX_QUESTION = 400;

const PATTERNS: [Intent, RegExp][] = [
  ["integrity", /\b(verify|verified|integrity|intact|tamper\w*|corrupt\w*|chain|trust(ed)?|signature|forged)\b/i],
  ["changes", /\b(what('s| has| have)? changed|changes?|changed since|since (the )?(last|official|approved|decision)|drift(ed)?|different now|stale)\b/i],
  ["recommend", /\b(should (we|i)|recommend|ship|roll ?out|go live|launch|safe to|ok to|ready|proceed|promote)\b/i],
  ["why", /\b(why|reason|because|what happened|how come)\b/i],
  ["decision", /\b(who|approv\w*|official|decid\w*|decision|sign(ed)? off|pending|proposal|proposed)\b/i],
  ["risks", /\b(risk\w*|open (issues|questions)|problem\w*|issues?|findings?|violation\w*|breach\w*|worr\w*|wrong|block\w*)\b/i],
  ["history", /\b(history|timeline|log|ledger|recent|audit|events?)\b/i],
  ["status", /\b(status|state|summary|summari[sz]e|overview|where (are|do) we|how('s| is| are)|brief|tl;?dr|update)\b/i],
  ["help", /\b(help|what can you|how do (i|you)|commands?|capabilit\w*)\b/i],
];

export function classify(question: string): Intent {
  const q = question.trim();
  if (!q) return "help";
  // A definition request: an "explain"-style lead-in plus either an UPPER_CASE code or a status word. Case-sensitive on purpose,
  // otherwise any five-letter word would look like a code.
  if (/\b(explain|what (is|does)|what's|meaning of|define)\b/i.test(q) && (/\b[A-Z][A-Z_]{4,}\b/.test(q) || /\b(breach|warning|healthy|recovering|insufficient)\b/i.test(q))) return "explain";
  for (const [intent, re] of PATTERNS) if (re.test(q)) return intent;
  return "unknown";
}

export const GLOSSARY: Record<string, string> = {
  BREACH: "A guardrail metric for this variant is worse than the baseline by more than its threshold and the confidence interval excludes zero.",
  WARNING: "A metric is trending toward its threshold but is not yet a confirmed breach.",
  HEALTHY: "Every guardrail metric has enough samples and none is worse than baseline beyond its threshold.",
  RECOVERING: "A breach cleared but not enough clean windows have passed to call the variant healthy.",
  INSUFFICIENT_DATA: "At least one metric does not yet have enough samples to judge.",
  WINNER_AND_SAFE: "Flagsmith reports a winner and the reliability guardrails are healthy.",
  WINNER_BUT_UNSAFE: "Flagsmith reports a winner on conversion, but the variant breaches a reliability guardrail.",
  HEALTHY_BUT_INCONCLUSIVE: "Guardrails are healthy but Flagsmith has no winner yet.",
  INSUFFICIENT_EVIDENCE: "Neither verdict has enough data.",
  REQUIRES_INVESTIGATION: "The two verdicts disagree or a data source is unavailable; a person should look.",
  ASSIGNMENT_MISMATCH: "Surfaces report different variants for the same subject, or a surface differs from what Flagsmith assigns now.",
  ENVIRONMENT_MISMATCH: "A surface used a different Flagsmith environment from the one the contract names.",
  IDENTITY_UNLINKED: "An observation had no verifiable identity token and is excluded from comparisons.",
  CONTRACT_VERSION_MISMATCH: "A surface reported against a different contract version.",
  COMBINATION_VIOLATION: "The feature values resolved across surfaces are not an allowed combination for the variant.",
  MISSING_SURFACE: "A required surface has not reported for a subject. Treated as delayed first, incomplete later; it does not prove failure.",
  STALE_OBSERVATION: "A surface's latest observation is older than the contract's freshness limit.",
};

const SUGGESTIONS = ["What is the current status?", "Should we ship this?", "What changed since the last decision?", "What are the open risks?", "Who approved the current decision?", "Show the history", "Is the ledger intact?"];
const ago = (ms: number, now: number): string => { const m = Math.max(0, Math.round((now - ms) / 60000)); return m < 1 ? "just now" : m < 120 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
const f = (b: Brief) => b.facts as Record<string, any>;

function statusLines(b: Brief, cites: Citation[]): string[] {
  const x = f(b), L: string[] = [];
  if (b.scope.type === "plan") {
    L.push(`${b.title}: ${x.verdict.outcome.replaceAll("_", " ")}. ${x.verdict.headline}`);
    cites.push({ type: "fact", ref: "verdict.outcome" });
    L.push(`Flagsmith: ${x.flagsmith.linked ? `experiment ${x.flagsmith.experimentId} is ${x.flagsmith.status}` : "not linked to an experiment"}. Reliability: ${x.verdict.reliabilityStatus}.`);
    for (const v of x.variants as { variant: string; status: string; breached: string[] }[]) L.push(`  ${v.variant}: ${v.status}${v.breached.length ? ` (breached: ${v.breached.join(", ")})` : ""}`);
    for (const c of x.contracts as Record<string, unknown>[]) { L.push(`Contract ${String(c.id)} v${String(c.version)}: ${String(c.status)}${c.primaryCode ? ` (${String(c.primaryCode)})` : ""}, ${String(c.errors)} error(s), ${String(c.warnings)} warning(s).`); cites.push({ type: "contract", ref: String(c.id) }); }
    L.push(`Plan approval: ${x.approval.status}${x.approval.by ? ` by ${x.approval.by}` : ""}. Evidence snapshots: ${x.evidence.count}.`);
  } else {
    L.push(`Contract ${b.title} v${x.contract.version}: ${String(x.status).replaceAll("_", " ")}${x.primaryCode ? ` (${x.primaryCode})` : ""}.`);
    L.push(`Observations: ${x.observations.linked} linked, ${x.observations.unlinked} unlinked, across ${x.subjects} subject(s).`);
    for (const s of x.surfaces as { id: string; status: string; subjects: number; errors: number }[]) L.push(`  ${s.id}: ${s.status} (${s.subjects} subjects, ${s.errors} error(s))`);
    cites.push({ type: "contract", ref: b.title });
  }
  return L;
}

function decisionLine(b: Brief, cites: Citation[]): string {
  const d = b.officialDecision;
  if (!d) return "No official decision has been recorded.";
  cites.push({ type: "ledger", ref: `#${d.resolutionSeq}` });
  return `Official decision #${d.seq}: ${d.decision.toUpperCase()}, proposed by ${d.proposedBy}, approved by ${d.approvedBy} ${ago(d.at, b.generatedAt)}. Rationale: ${d.rationale}`;
}

export function recommend(b: Brief): { decision: Decision; rationale: string; blockers: string[]; cites: Citation[] } {
  const x = f(b), cites: Citation[] = [], blockers: string[] = [];
  const contracts: Record<string, any>[] = b.scope.type === "plan" ? x.contracts : [{ id: b.title, status: x.status, primaryCode: x.primaryCode, errors: (b.keyFacts.findingsByCode ? 1 : 0) }];
  const bad = contracts.filter((c) => c.status === "CONTRACT_VIOLATION");
  if (!b.integrity.ok) blockers.push(`the decision ledger failed verification (${b.integrity.reason})`);
  if (bad.length) { for (const c of bad) { blockers.push(`contract ${c.id} reports ${c.primaryCode ?? "a violation"}`); cites.push({ type: "contract", ref: String(c.id) }); } return { decision: "hold", rationale: `Hold: ${blockers.join("; ")}. Fix the violation, re-run the contract check, then re-assess.`, blockers, cites }; }
  if (b.scope.type === "contract") {
    if (x.status === "CONTRACT_VALID") return { decision: "ship", rationale: "The contract is valid: surfaces agree on the assignment and report an allowed feature combination.", blockers, cites: [{ type: "contract", ref: b.title }] };
    return { decision: "hold", rationale: `Hold: the contract is ${String(x.status).replaceAll("_", " ").toLowerCase()}, which is not enough evidence to proceed.`, blockers: [`contract status ${x.status}`], cites: [{ type: "contract", ref: b.title }] };
  }
  const o = x.verdict.outcome as string;
  cites.push({ type: "fact", ref: "verdict.outcome" });
  // An empty or thin live window is not an all-clear. Fall back on the newest stored evidence, and on the official decision if any.
  const latest = x.evidence?.latest as { id: number; at: number; outcome: string | null } | null | undefined;
  if (o === "INSUFFICIENT_EVIDENCE" && latest?.outcome && latest.outcome !== "INSUFFICIENT_EVIDENCE") {
    const base = `The live data window is empty or too small right now, which is not an all-clear: evidence snapshot #${latest.id} (${new Date(latest.at).toISOString().slice(0, 16).replace("T", " ")} UTC) recorded ${latest.outcome.replaceAll("_", " ")}.`;
    cites.push({ type: "evidence", ref: `#${latest.id}` });
    const off = b.officialDecision;
    if (off) { cites.push({ type: "ledger", ref: `#${off.resolutionSeq}` }); return { decision: off.decision as Decision, rationale: `${base} Official decision #${off.seq} (${off.decision.toUpperCase()}) stands until new evidence supersedes it.`, blockers: ["no current data to supersede the last evidence"], cites }; }
    return { decision: "hold", rationale: `Hold: ${base} Capture fresh evidence before deciding.`, blockers: ["no current data; the last snapshot was not an all-clear"], cites };
  }
  if (o === "WINNER_BUT_UNSAFE") return { decision: "pause", rationale: `Pause: ${x.verdict.headline} Investigate the breached guardrails before any rollout.`, blockers: ["reliability guardrail breach"], cites };
  if (o === "REQUIRES_INVESTIGATION") return { decision: "hold", rationale: `Hold: ${x.verdict.headline}`, blockers: ["verdicts disagree or a data source is unavailable"], cites };
  if (o === "INSUFFICIENT_EVIDENCE" || o === "HEALTHY_BUT_INCONCLUSIVE") return { decision: "extend", rationale: `Extend: ${x.verdict.headline} Keep collecting data.`, blockers: [], cites };
  if (o === "WINNER_AND_SAFE") {
    if (blockers.length) return { decision: "hold", rationale: `Hold: ${blockers.join("; ")}.`, blockers, cites };
    const caveat = x.contracts.length === 0 ? " No cross-surface contract covers this flag, so consistency across surfaces is unchecked." : "";
    return { decision: "ship", rationale: `Ship: Flagsmith reports a winner and the reliability guardrails are healthy.${caveat}`, blockers, cites };
  }
  return { decision: "hold", rationale: "Hold: the evidence does not support a decision yet.", blockers, cites };
}

export function answer(b: Brief, question: string): Answer {
  const q = question.slice(0, MAX_QUESTION);
  const intent = classify(q);
  const cites: Citation[] = [];
  let lines: string[] = [];
  let draft: Draft | null = null;
  const x = f(b);

  switch (intent) {
    case "help":
      lines = ["I answer from this experiment's stored records, not from a model. Ask about: status, whether to ship, what changed since the last decision, open risks, who approved what, the history, whether the ledger is intact, or what a term like BREACH means.", "I can draft a decision for you to record. Only a person can propose, approve or reject it."];
      break;
    case "status": lines = [...statusLines(b, cites), decisionLine(b, cites)]; break;
    case "why": {
      if (b.officialDecision) { lines.push(decisionLine(b, cites)); }
      const control = b.recent.filter((e) => e.kind === "control.executed" || e.kind === "plan.approval");
      for (const e of control.slice(0, 3)) { lines.push(`#${e.seq} ${e.kind} by ${e.actor}: ${e.summary}`); cites.push({ type: "ledger", ref: `#${e.seq}` }); }
      if (!lines.length) lines.push("No decision or control action is recorded, so there is nothing to explain yet.");
      if (b.scope.type === "plan") { lines.push(`Current evidence: ${x.verdict.headline}`); cites.push({ type: "fact", ref: "verdict.headline" }); for (const e of (x.verdict.evidence as string[]).slice(0, 3)) lines.push(`  - ${e}`); }
      else for (const o of (x.openFindings as { code: string; message: string; dedupeKey: string }[]).slice(0, 3)) { lines.push(`  - ${o.code}: ${o.message}`); cites.push({ type: "finding", ref: o.dedupeKey }); }
      break;
    }
    case "changes":
      if (!b.officialDecision) { lines.push("There is no official decision to compare against. Showing the open questions instead."); lines.push(...b.openQuestions.map((s) => `  - ${s}`)); }
      else if (!b.changedSinceOfficialDecision.length) { lines.push(`Nothing that a decision depends on has changed since official decision #${b.officialDecision.seq}.`); cites.push({ type: "ledger", ref: `#${b.officialDecision.resolutionSeq}` }); }
      else { lines.push(`${b.changedSinceOfficialDecision.length} fact(s) changed since official decision #${b.officialDecision.seq}:`); cites.push({ type: "ledger", ref: `#${b.officialDecision.resolutionSeq}` }); for (const c of b.changedSinceOfficialDecision) lines.push(`  - ${c.field}: ${JSON.stringify(c.then)} -> ${JSON.stringify(c.now)}`); }
      if (b.pendingProposals.some((p) => p.stale)) lines.push("A pending proposal was written against older facts; approving it will require acknowledging the changes.");
      break;
    case "recommend": {
      const r = recommend(b);
      draft = { decision: r.decision, rationale: r.rationale };
      lines.push(`Based on the records, the supported decision is: ${r.decision.toUpperCase()}.`, r.rationale);
      if (r.blockers.length) lines.push(`Blockers: ${r.blockers.join("; ")}.`);
      lines.push("This is a draft. A person must record it as a proposal, and a second person must approve it before it is official.");
      cites.push(...r.cites);
      break;
    }
    case "decision":
      lines.push(decisionLine(b, cites));
      for (const p of b.pendingProposals) { lines.push(`Pending #${p.seq}: ${p.decision.toUpperCase()} proposed by ${p.proposedBy} ${ago(p.at, b.generatedAt)}${p.stale ? " (facts have changed since)" : ""}.`); cites.push({ type: "ledger", ref: `#${p.seq}` }); }
      if (!b.pendingProposals.length) lines.push("No proposals are waiting for approval.");
      break;
    case "risks": {
      lines.push(...(b.openQuestions.length ? b.openQuestions.map((s) => `- ${s}`) : ["No open questions."]));
      if (b.scope.type === "plan") for (const v of x.variants as { variant: string; status: string; breached: string[] }[]) if (v.status === "BREACH" || v.status === "WARNING") { lines.push(`- ${v.variant} is ${v.status}${v.breached.length ? ` on ${v.breached.join(", ")}` : ""}.`); cites.push({ type: "fact", ref: `variants.${v.variant}` }); }
      if (b.scope.type === "contract") for (const o of (x.openFindings as { code: string; severity: string; surfaceId: string | null; message: string; dedupeKey: string }[]).slice(0, 8)) { lines.push(`- ${o.severity.toUpperCase()} ${o.code}${o.surfaceId ? ` [${o.surfaceId}]` : ""}: ${o.message}`); cites.push({ type: "finding", ref: o.dedupeKey }); }
      break;
    }
    case "integrity":
      lines.push(b.integrity.ok ? `The ledger verifies: ${b.integrity.entries} entries, every hash link and signature checks out. Head ${b.integrity.head?.slice(0, 16) ?? "(empty)"}. Truncation of the newest entries cannot be detected from inside the database; compare the head with a copy you stored elsewhere.` : `The ledger FAILED verification: ${b.integrity.reason}. Do not rely on its records until this is explained.`);
      break;
    case "history":
      if (!b.recent.length) lines.push("No ledger entries exist for this subject yet.");
      for (const e of b.recent.slice(0, 10)) { lines.push(`#${e.seq} ${ago(e.ts, b.generatedAt)} ${e.kind} by ${e.actor}: ${e.summary}`); cites.push({ type: "ledger", ref: `#${e.seq}` }); }
      break;
    case "explain": {
      const hit = Object.keys(GLOSSARY).find((k) => new RegExp(`\\b${k}\\b`, "i").test(q.replaceAll(" ", "_")) || new RegExp(`\\b${k.replaceAll("_", "[ _]")}\\b`, "i").test(q));
      if (hit) lines.push(`${hit}: ${GLOSSARY[hit]}`);
      else lines.push(`I know these terms: ${Object.keys(GLOSSARY).join(", ")}.`);
      break;
    }
    case "unknown":
      lines = ["I could not match that to something I can answer from the records. I do not guess."];
      break;
  }
  return { intent, answer: lines[0] ?? "", lines, citations: dedupe(cites), suggestions: intent === "unknown" || intent === "help" ? SUGGESTIONS : SUGGESTIONS.filter((s) => !s.toLowerCase().includes(intent)).slice(0, 4), draft, basedOn: { fingerprint: b.fingerprint, generatedAt: b.generatedAt } };
}

const dedupe = (c: Citation[]): Citation[] => [...new Map(c.map((x) => [`${x.type}:${x.ref}`, x])).values()];
export const DECISION_CHOICES = DECISIONS;
