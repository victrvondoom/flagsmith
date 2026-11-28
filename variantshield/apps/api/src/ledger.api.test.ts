import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { createApp, type App } from "./app.ts";
import { EXAMPLE_MANIFEST } from "./contract-sim.ts";
import { deriveSurfaceKey } from "./surface-keys.ts";
import { verifyChain, GENESIS, type LedgerEntry } from "./ledger.ts";
import { answer, classify, recommend } from "./assistant.ts";
import { buildBrief, diffKeyFacts } from "./briefing.ts";

process.env.VARIANTSHIELD_LOG = "off";
const ADMIN = "admin-token-for-tests-0123", VIEWER = "viewer-token-for-tests-0123", INGEST = "ingest-key-for-tests-0123", ISSUER = "issuer-key-for-tests-0123", SECRET = "identity-secret-for-tests-0123456789";
let app: App, base: string, clock = 1_800_000_000_000;

async function start(extra: Record<string, string> = {}): Promise<void> {
  const cfg = loadConfig({ VARIANTSHIELD_ADMIN_TOKEN: ADMIN, VARIANTSHIELD_VIEWER_TOKEN: VIEWER, VARIANTSHIELD_INGEST_KEY: INGEST, VARIANTSHIELD_IDENTITY_ISSUER_KEY: ISSUER, VARIANTSHIELD_IDENTITY_SECRET: SECRET, VARIANTSHIELD_DB_PATH: ":memory:", PORT: "0", ...extra });
  clock = 1_800_000_000_000;
  app = createApp({ cfg, db: new Db(":memory:"), now: () => clock, flagsmith: null });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}
const as = (actor: string, token = ADMIN): Record<string, string> => ({ authorization: `Bearer ${token}`, "x-variantshield-actor": actor });
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = as("alice")) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const manifest = (): any => parseYaml(readFileSync(EXAMPLE_MANIFEST, "utf8"));
const simPlan = async (id: string): Promise<number> => (await call("POST", `/api/simulate/${id}`)).json.plan.id;
const ledger = async (q = "") => (await call("GET", `/api/ledger${q}`)).json.entries as LedgerEntry[];
const propose = (planId: number, decision = "pause", rationale = "Payment failures regressed on the treatment variant.", actor = "alice") =>
  call("POST", "/api/ledger/decisions", { scope: { type: "plan", id: String(planId) }, decision, rationale }, as(actor));
const resolve = (seq: number, action: "approve" | "reject", actor = "bob", over: Record<string, unknown> = {}) =>
  call("POST", `/api/ledger/decisions/${seq}/resolve`, { action, confirmation: `${action.toUpperCase()} ${seq}`, reason: "Reviewed the evidence", ...over }, as(actor));
const ask = (scope: { type: string; id: string }, question: string, headers = as("alice")) => call("POST", "/api/assistant/ask", { scope, question }, headers);

afterEach(async () => { await new Promise<void>((r) => app.server.close(() => r())); app.ctx.db.close(); });

describe("ledger: capture, chain and tamper evidence", () => {
  beforeEach(() => start());

  it("capture__existing_flows__append_entries_and_the_chain_verifies", async () => {
    const id = await simPlan("dangerous-winner");
    await call("PATCH", `/api/plans/${id}/approval`, { decision: "approved", note: "Plan reviewed" }).catch(() => null);
    await call("POST", `/api/plans/${id}/approval`, { decision: "approved", note: "Plan reviewed" });
    await call("POST", `/api/plans/${id}/evidence`);
    await call("POST", "/api/contracts", manifest());
    const kinds = (await ledger()).map((e) => e.kind);
    assert.ok(kinds.includes("plan.approval") && kinds.includes("evidence.snapshot") && kinds.includes("contract.registered"), kinds.join(","));
    const v = (await call("GET", "/api/ledger/verify")).json;
    assert.equal(v.ok, true);
    assert.equal(v.signaturesChecked, true);
    assert.ok(v.entries >= 3 && /^[0-9a-f]{64}$/.test(v.head));
  });

  it("capture__executed_control_action__is_recorded_and_dry_runs_are_not", async () => {
    const id = await simPlan("dangerous-winner");
    await call("POST", "/api/control", { planId: id, action: "pause", dryRun: true });
    assert.equal((await ledger("?kind=control.executed")).length, 0);
    const key = (await call("GET", `/api/plans/${id}`)).json.plan.key;
    const r = await call("POST", "/api/control", { planId: id, action: "pause", dryRun: false, confirmation: `PAUSE ${key}`, reason: "Payment failures regressed" });
    assert.equal(r.json.outcome, "executed", JSON.stringify(r.json));
    const e = (await ledger("?kind=control.executed"))[0]!;
    assert.equal(e.payload.action, "pause");
    assert.equal(e.source, "simulation");
  });

  it("capture__contract_check__is_recorded_only_when_the_status_changes", async () => {
    await call("POST", "/api/contracts", manifest());
    await call("POST", "/api/contracts/checkout-journey/check");
    await call("POST", "/api/contracts/checkout-journey/check");
    assert.equal((await ledger("?kind=contract.checked")).length, 1);
  });

  it("chain__entries_link_to_the_previous_hash_starting_from_genesis", async () => {
    await simPlan("safe-winner");
    const id = await simPlan("dangerous-winner");
    await call("POST", `/api/plans/${id}/evidence`);
    const all = (await call("GET", "/api/ledger/export")).json.entries as LedgerEntry[];
    assert.equal(all[0]!.prevHash, GENESIS);
    for (let i = 1; i < all.length; i++) assert.equal(all[i]!.prevHash, all[i - 1]!.hash);
  });

  it("append_only__update_and_delete_are_refused_by_the_database", async () => {
    await call("POST", "/api/ledger/notes", { scope: { type: "plan", id: String(await simPlan("safe-winner")) }, text: "first note" });
    assert.throws(() => app.ctx.db.run("UPDATE ledger_entries SET summary = 'edited' WHERE seq = 1"), /append-only/);
    assert.throws(() => app.ctx.db.run("DELETE FROM ledger_entries WHERE seq = 1"), /append-only/);
  });

  it("tamper__edited_entry__is_detected_at_that_entry", async () => {
    const id = await simPlan("safe-winner");
    for (const t of ["note one", "note two", "note three"]) await call("POST", "/api/ledger/notes", { scope: { type: "plan", id: String(id) }, text: t });
    // An attacker with file access drops the trigger and edits an entry in the middle.
    app.ctx.db.raw.exec("DROP TRIGGER ledger_no_update");
    const target = (await ledger("?kind=note")).find((e) => e.summary === "note two")!;
    app.ctx.db.run("UPDATE ledger_entries SET summary = 'note TWO (edited)' WHERE seq = ?", target.seq);
    const v = (await call("GET", "/api/ledger/verify")).json;
    assert.equal(v.ok, false);
    assert.equal(v.firstBadSeq, target.seq);
    assert.match(v.reason, /does not match its hash/);
  });

  it("tamper__removed_entry__breaks_the_chain_and_a_rehashed_forgery_fails_the_signature", async () => {
    const id = await simPlan("safe-winner");
    for (const t of ["note one", "note two", "note three"]) await call("POST", "/api/ledger/notes", { scope: { type: "plan", id: String(id) }, text: t });
    const entries = (await call("GET", "/api/ledger/export")).json.entries as LedgerEntry[];
    const middle = entries.findIndex((e) => e.summary === "note two");
    const without = entries.filter((_, i) => i !== middle);
    assert.match(verifyChain(without, null).reason ?? "", /chain broken/);
    // Forge a consistent chain by recomputing hashes without the key: structure verifies, signatures do not.
    const keys = app.ctx.cfg.ledgerKeys;
    assert.equal(verifyChain(entries, keys).ok, true);
    const forged = entries.map((e) => ({ ...e }));
    forged[middle]!.signature = "A".repeat(43);
    const r = verifyChain(forged, keys);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /signature/);
  });

  it("signing__a_rotated_key_still_verifies_old_entries_when_kept_as_previous", async () => {
    await call("POST", "/api/ledger/notes", { scope: { type: "plan", id: String(await simPlan("safe-winner")) }, text: "signed with the old key" });
    const entries = (await call("GET", "/api/ledger/export")).json.entries as LedgerEntry[];
    const [current] = app.ctx.cfg.ledgerKeys;
    assert.equal(verifyChain(entries, ["a-new-ledger-key-0123456789", current!]).ok, true);
    assert.equal(verifyChain(entries, ["a-new-ledger-key-0123456789"]).ok, false);
  });

  it("notes__unknown_subject_and_bad_text__are_rejected", async () => {
    assert.equal((await call("POST", "/api/ledger/notes", { scope: { type: "plan", id: "9999" }, text: "hello there" })).status, 404);
    assert.equal((await call("POST", "/api/ledger/notes", { scope: { type: "contract", id: "nope" }, text: "hello there" })).status, 404);
    const id = await simPlan("safe-winner");
    assert.equal((await call("POST", "/api/ledger/notes", { scope: { type: "plan", id: String(id) }, text: "x" })).status, 400);
    assert.equal((await call("POST", "/api/ledger/notes", { scope: { type: "plan", id: "../etc" }, text: "hello there" })).status, 400);
  });
});

describe("ledger: decisions become official only after a second person approves", () => {
  beforeEach(() => start());

  it("flow__propose_then_approve_by_another_actor__is_official_and_visible_in_the_brief", async () => {
    const id = await simPlan("dangerous-winner");
    const p = await propose(id);
    assert.equal(p.status, 200);
    assert.equal(p.json.entry.kind, "decision.proposed");
    let brief = (await call("GET", `/api/context/plan/${id}`)).json.brief;
    assert.equal(brief.officialDecision, null);
    assert.equal(brief.pendingProposals.length, 1);
    const r = await resolve(p.json.entry.seq, "approve", "bob");
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.entry.kind, "decision.approved");
    assert.equal(r.json.entry.refSeq, p.json.entry.seq);
    brief = (await call("GET", `/api/context/plan/${id}`)).json.brief;
    assert.equal(brief.officialDecision.decision, "pause");
    assert.equal(brief.officialDecision.approvedBy, "bob");
    assert.equal(brief.officialDecision.proposedBy, "alice");
    assert.equal(brief.pendingProposals.length, 0);
  });

  it("rule__the_proposer_cannot_approve_their_own_decision", async () => {
    const id = await simPlan("dangerous-winner");
    const p = await propose(id);
    const r = await resolve(p.json.entry.seq, "approve", "alice");
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, "self_approval_forbidden");
    assert.equal((await ledger("?kind=decision.approved")).length, 0);
  });

  it("rule__self_approval_can_be_enabled_for_single_operator_instances", async () => {
    await app.server.close(); app.ctx.db.close();
    await start({ VARIANTSHIELD_ALLOW_SELF_APPROVAL: "true" });
    const id = await simPlan("dangerous-winner");
    const p = await propose(id);
    assert.equal((await resolve(p.json.entry.seq, "approve", "alice")).status, 200);
  });

  it("rule__rejecting_your_own_proposal_is_allowed", async () => {
    const id = await simPlan("dangerous-winner");
    const p = await propose(id);
    assert.equal((await resolve(p.json.entry.seq, "reject", "alice")).json.entry.kind, "decision.rejected");
  });

  it("rule__typed_confirmation_and_a_reason_are_required", async () => {
    const id = await simPlan("dangerous-winner");
    const p = await propose(id);
    const seq = p.json.entry.seq;
    assert.equal((await resolve(seq, "approve", "bob", { confirmation: "yes" })).json.error.code, "confirmation_required");
    assert.equal((await resolve(seq, "approve", "bob", { confirmation: `REJECT ${seq}` })).json.error.code, "confirmation_required");
    assert.equal((await resolve(seq, "approve", "bob", { reason: "" })).status, 400);
    assert.equal((await ledger("?kind=decision.approved")).length, 0);
  });

  it("rule__a_proposal_resolves_once", async () => {
    const id = await simPlan("dangerous-winner");
    const p = await propose(id);
    await resolve(p.json.entry.seq, "approve", "bob");
    const again = await resolve(p.json.entry.seq, "reject", "carol");
    assert.equal(again.status, 409);
    assert.equal(again.json.error.code, "already_resolved");
  });

  it("rule__proposals_need_a_valid_decision_and_a_real_rationale", async () => {
    const id = await simPlan("dangerous-winner");
    assert.equal((await propose(id, "yolo")).status, 400);
    assert.equal((await propose(id, "ship", "ok")).status, 400);
    assert.equal((await propose(id, "ship", "x".repeat(2001))).status, 400);
    assert.equal((await call("POST", "/api/ledger/decisions", { scope: { type: "plan", id: "424242" }, decision: "ship", rationale: "long enough rationale" })).status, 404);
  });

  it("stale_context__approval_after_the_facts_changed_needs_an_explicit_acknowledgement", async () => {
    const id = await simPlan("safe-winner");
    const p = await propose(id, "ship", "Flagsmith winner and healthy guardrails.");
    // The facts change after the proposal: the plan's own approval status is part of what a decision depends on.
    await call("POST", `/api/plans/${id}/approval`, { decision: "rejected", note: "Compliance objection" });
    const blocked = await resolve(p.json.entry.seq, "approve", "bob");
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error.code, "context_changed");
    assert.ok(blocked.json.error.detail.changes.some((c: any) => c.field === "planApproval"));
    const ok = await resolve(p.json.entry.seq, "approve", "bob", { acknowledgeChanges: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.entry.payload.approvedOnChangedContext, true);
  });

  it("changes__since_the_official_decision__lists_exactly_what_moved", async () => {
    const id = await simPlan("safe-winner");
    const p = await propose(id, "ship", "Flagsmith winner and healthy guardrails.");
    await resolve(p.json.entry.seq, "approve", "bob");
    assert.equal((await call("GET", `/api/context/plan/${id}`)).json.brief.changedSinceOfficialDecision.length, 0);
    await call("POST", `/api/plans/${id}/approval`, { decision: "approved", note: "Now approved" });
    const brief = (await call("GET", `/api/context/plan/${id}`)).json.brief;
    assert.deepEqual(brief.changedSinceOfficialDecision.map((c: any) => [c.field, c.then, c.now]), [["planApproval", "pending", "approved"]]);
    assert.ok(brief.openQuestions.some((q: string) => /changed since the official decision/.test(q)));
  });

  it("source__simulated_plans_are_labelled_so_they_cannot_pass_as_real_decisions", async () => {
    const id = await simPlan("dangerous-winner");
    const p = await propose(id);
    assert.equal(p.json.entry.source, "simulation");
    assert.equal((await call("GET", `/api/context/plan/${id}`)).json.brief.source, "simulation");
  });
});

describe("context layer and assistant", () => {
  beforeEach(() => start());

  it("classify__questions_map_to_intents", () => {
    const cases: [string, string][] = [
      ["What is the current status?", "status"], ["Should we ship this?", "recommend"], ["What changed since the last decision?", "changes"], ["What are the open risks?", "risks"],
      ["Who approved the current decision?", "decision"], ["Show the history", "history"], ["Is the ledger intact?", "integrity"], ["Why was it paused?", "why"],
      ["explain BREACH", "explain"], ["what can you do", "help"], ["tell me a joke", "unknown"], ["", "help"],
    ];
    for (const [q, intent] of cases) assert.equal(classify(q), intent, q);
  });

  it("assistant__dangerous_winner__recommends_pause_with_a_citation_and_a_draft_only", async () => {
    const id = await simPlan("dangerous-winner");
    const r = (await ask({ type: "plan", id: String(id) }, "Should we ship this?")).json.answer;
    assert.equal(r.intent, "recommend");
    assert.equal(r.draft.decision, "pause");
    assert.match(r.lines.join(" "), /draft/i);
    assert.ok(r.citations.some((c: any) => c.ref === "verdict.outcome"));
    assert.equal((await ledger("?kind=decision.proposed")).length, 0, "the assistant must not record anything");
  });

  it("assistant__safe_winner__drafts_ship_and_names_the_missing_contract", async () => {
    const id = await simPlan("safe-winner");
    const r = (await ask({ type: "plan", id: String(id) }, "is it safe to roll out?")).json.answer;
    assert.equal(r.draft.decision, "ship");
    assert.match(r.draft.rationale, /No cross-surface contract/);
  });

  it("assistant__status_why_risks_history_decision_and_integrity__answer_from_records", async () => {
    const id = await simPlan("dangerous-winner");
    const scope = { type: "plan", id: String(id) };
    const p = await propose(id);
    await resolve(p.json.entry.seq, "approve", "bob");
    const status = (await ask(scope, "status")).json.answer;
    assert.match(status.lines.join("\n"), /upi_first: BREACH/);
    assert.match(status.lines.join("\n"), /Official decision #\d+: PAUSE/);
    const why = (await ask(scope, "why was this paused?")).json.answer;
    assert.ok(why.citations.some((c: any) => c.type === "ledger"));
    assert.match((await ask(scope, "what are the risks")).json.answer.lines.join("\n"), /upi_first is BREACH/);
    assert.ok((await ask(scope, "show the history")).json.answer.citations.length >= 2);
    assert.match((await ask(scope, "who approved it?")).json.answer.lines.join("\n"), /approved by bob/);
    assert.match((await ask(scope, "is the ledger intact?")).json.answer.answer, /verifies/);
  });

  it("assistant__integrity_failure__is_reported_not_hidden", async () => {
    const id = await simPlan("safe-winner");
    await call("POST", "/api/ledger/notes", { scope: { type: "plan", id: String(id) }, text: "a note to tamper with" });
    app.ctx.db.raw.exec("DROP TRIGGER ledger_no_update");
    app.ctx.db.run("UPDATE ledger_entries SET summary = 'tampered' WHERE kind = 'note'");
    const r = (await ask({ type: "plan", id: String(id) }, "is the ledger intact?")).json.answer;
    assert.match(r.answer, /FAILED verification/);
    const rec = (await ask({ type: "plan", id: String(id) }, "should we ship?")).json.answer;
    assert.equal(rec.draft.decision, "hold");
    assert.match(rec.lines.join(" "), /ledger failed verification/);
  });

  it("assistant__unknown_and_empty_questions__do_not_guess", async () => {
    const id = await simPlan("safe-winner");
    const u = (await ask({ type: "plan", id: String(id) }, "write me a poem about toggles")).json.answer;
    assert.equal(u.intent, "unknown");
    assert.match(u.answer, /do not guess/);
    assert.ok(u.suggestions.length >= 4);
    assert.equal((await ask({ type: "plan", id: String(id) }, "x".repeat(401))).status, 400);
    assert.equal((await ask({ type: "plan", id: "abc" }, "status")).status, 400);
    assert.equal((await ask({ type: "plan", id: "99999" }, "status")).status, 404);
  });

  it("assistant__explain__defines_terms_from_the_glossary", async () => {
    const id = await simPlan("safe-winner");
    assert.match((await ask({ type: "plan", id: String(id) }, "explain WINNER_BUT_UNSAFE")).json.answer.answer, /breaches a reliability guardrail/);
  });

  it("contract_scope__violation_blocks_a_ship_recommendation_and_cites_findings", async () => {
    await call("POST", "/api/contracts", manifest());
    const id = (await call("POST", "/api/identity/issue", { subject: "cust-1" }, { "x-identity-issuer-key": ISSUER })).json;
    const obs = (surfaceId: string, features: Record<string, string>) => ({ observationId: `led-${surfaceId}-01`, contractId: "checkout-journey", contractVersion: 1, experimentKey: "checkout_journey", environment: "production", envFingerprint: "aaaaaaaaaaaaaaaa", assignmentFlag: "checkout_journey_variant", assignedVariant: "upi_first", surfaceId, identityToken: id.token, observedAt: clock - 5000, features });
    const post = (surfaceId: string, features: Record<string, string>) => call("POST", "/api/contract-observations", { observations: [obs(surfaceId, features)] }, { "x-surface-key": deriveSurfaceKey(INGEST, "checkout-journey", surfaceId) });
    await post("web-checkout", { checkout_ui: "upi_first" });
    await post("mobile-checkout", { checkout_ui: "upi_first" });
    await post("payment-api", { payment_route: "legacy" });
    await post("risk-engine", { retry_policy: "bounded" });
    const scope = { type: "contract", id: "checkout-journey" };
    const rec = (await ask(scope, "should we ship?")).json.answer;
    assert.equal(rec.draft.decision, "hold");
    assert.match(rec.lines.join(" "), /COMBINATION_VIOLATION/);
    assert.ok(rec.citations.some((c: any) => c.type === "contract"));
    const risks = (await ask(scope, "what are the open risks?")).json.answer;
    assert.ok(risks.citations.some((c: any) => c.type === "finding"));
  });

  it("recommend__an_empty_live_window_after_a_bad_snapshot__is_not_an_all_clear", async () => {
    // Given a plan whose newest evidence snapshot said WINNER_BUT_UNSAFE, an official PAUSE, and a live window that has emptied
    const id = await simPlan("dangerous-winner");
    await call("POST", `/api/plans/${id}/evidence`);
    const p = await propose(id);
    await resolve(p.json.entry.seq, "approve", "bob");
    const brief = await buildBrief(app.ctx, { type: "plan", id: String(id) });
    assert.equal((brief.facts as any).evidence.latest.outcome, "WINNER_BUT_UNSAFE");
    const emptied = { ...brief, facts: { ...brief.facts, verdict: { ...(brief.facts as any).verdict, outcome: "INSUFFICIENT_EVIDENCE", headline: "Insufficient evidence: reliability cannot be judged yet." } } };
    // When asked whether to ship
    const r = recommend(emptied as never);
    // Then it does not suggest extending as if nothing happened: the official decision stands and the snapshot is cited
    assert.equal(r.decision, "pause");
    assert.match(r.rationale, /not an all-clear/);
    assert.match(r.rationale, /Official decision #\d+ \(PAUSE\) stands/);
    assert.ok(r.cites.some((c) => c.type === "evidence"));
    // And without an official decision it holds rather than extends
    const noOfficial = { ...emptied, officialDecision: null };
    assert.equal(recommend(noOfficial as never).decision, "hold");
    // A plan that never had a bad snapshot still extends
    const quiet = { ...emptied, facts: { ...emptied.facts, evidence: { ...(emptied.facts as any).evidence, latest: null } }, officialDecision: null };
    assert.equal(recommend(quiet as never).decision, "extend");
  });

  it("brief__a_plan_includes_contracts_that_check_the_same_flag", async () => {
    await call("POST", "/api/contracts", manifest());
    const created = await call("POST", "/api/plans", { title: "Checkout journey", treatmentVariants: ["upi_first"], featureKey: "checkout_journey_variant" });
    const brief = (await call("GET", `/api/context/plan/${created.json.plan.id}`)).json.brief;
    assert.deepEqual(brief.facts.contracts.map((c: any) => c.id), ["checkout-journey"]);
    assert.equal(brief.keyFacts.contracts["checkout-journey"], "NO_DATA");
    assert.ok(brief.openQuestions.some((q: string) => /has received no observations/.test(q)));
  });

  it("brief__fingerprint_is_stable_and_changes_only_with_decision_relevant_facts", async () => {
    const id = await simPlan("safe-winner");
    const a = (await call("GET", `/api/context/plan/${id}`)).json.brief;
    clock += 60_000;
    const b = (await call("GET", `/api/context/plan/${id}`)).json.brief;
    assert.equal(a.fingerprint, b.fingerprint);
    await call("POST", `/api/plans/${id}/approval`, { decision: "approved", note: "ok" });
    assert.notEqual((await call("GET", `/api/context/plan/${id}`)).json.brief.fingerprint, a.fingerprint);
  });

  it("diff__key_facts__reports_added_removed_and_changed_fields", () => {
    const d = diffKeyFacts({ a: 1, v: { x: "HEALTHY" } }, { a: 1, v: { x: "BREACH", y: "HEALTHY" } });
    assert.deepEqual(d.map((c) => c.field), ["v.x", "v.y"]);
  });

  it("recommend__pure_function__prefers_hold_when_a_contract_is_violated", async () => {
    const id = await simPlan("safe-winner");
    const brief = await buildBrief(app.ctx, { type: "plan", id: String(id) });
    assert.equal(recommend(brief).decision, "ship");
    const withBad = { ...brief, facts: { ...brief.facts, contracts: [{ id: "c1", status: "CONTRACT_VIOLATION", primaryCode: "ASSIGNMENT_MISMATCH" }] } };
    assert.equal(recommend(withBad as never).decision, "hold");
    assert.equal(answer(brief, "what can you do").intent, "help");
  });
});

describe("ledger: access control", () => {
  beforeEach(() => start());

  it("viewer__can_read_the_ledger_context_and_ask_but_cannot_write", async () => {
    const id = await simPlan("dangerous-winner");
    const v = as("viewer", VIEWER);
    assert.equal((await call("GET", "/api/ledger", undefined, v)).status, 200);
    assert.equal((await call("GET", "/api/ledger/verify", undefined, v)).status, 200);
    assert.equal((await call("GET", `/api/context/plan/${id}`, undefined, v)).status, 200);
    assert.equal((await ask({ type: "plan", id: String(id) }, "status", v)).status, 200);
    assert.equal((await call("POST", "/api/ledger/notes", { scope: { type: "plan", id: String(id) }, text: "hello there" }, v)).status, 403);
    assert.equal((await call("POST", "/api/ledger/decisions", { scope: { type: "plan", id: String(id) }, decision: "ship", rationale: "long enough rationale" }, v)).status, 403);
    assert.equal((await call("POST", "/api/ledger/decisions/1/resolve", { action: "approve" }, v)).status, 403);
  });

  it("anonymous__everything_is_401", async () => {
    for (const [m, p] of [["GET", "/api/ledger"], ["GET", "/api/ledger/verify"], ["GET", "/api/context/plan/1"], ["POST", "/api/assistant/ask"], ["POST", "/api/ledger/decisions"]] as const) assert.equal((await call(m, p, m === "POST" ? {} : undefined, {})).status, 401, p);
  });
});
