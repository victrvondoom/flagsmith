import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Ctx } from "./context.ts";
import { HttpError } from "./http.ts";
import { canonicalJson } from "../../../packages/contracts/src/index.ts";

/**
 * Decision ledger: the durable, tamper-evident record of what was known and who decided what.
 *
 * - Append-only. SQL triggers refuse UPDATE and DELETE; nothing in the application edits an entry.
 * - Hash chain. Each entry's hash covers its content and the previous entry's hash, so changing or removing an entry in
 *   the middle breaks every hash after it.
 * - Signed. Each hash carries an HMAC made with a server-side key, so someone who can write the database file cannot
 *   forge a consistent chain without that key.
 * - A decision is "official" only once a different named actor has approved it (decision.approved). A proposal alone is not.
 *
 * Limits: truncating the newest entries cannot be detected from inside the database; record `head` somewhere else
 * (the verify endpoint returns it) and compare with --expect-head. `actor` is the name sent by the caller, so it is
 * attributable only as far as the admin credential is.
 */

export const GENESIS = "0".repeat(64);

export type LedgerKind =
  | "plan.approval" | "evidence.snapshot" | "control.executed" | "contract.registered" | "contract.checked"
  | "decision.proposed" | "decision.approved" | "decision.rejected" | "note"
  | "incident.opened" | "bisect.envelope.approved" | "bisect.probe" | "bisect.concluded" | "bisect.aborted"
  | "remediation.proposed" | "remediation.approved" | "remediation.executed" | "incident.resolved";
export type SubjectType = "plan" | "contract" | "system" | "incident";
export const DECISIONS = ["ship", "hold", "pause", "rollback", "extend"] as const;
export type Decision = (typeof DECISIONS)[number];

export interface LedgerEntry {
  seq: number; entryId: string; ts: number; kind: LedgerKind; subjectType: SubjectType; subjectId: string; actor: string;
  summary: string; payload: Record<string, unknown>; refSeq: number | null; source: "real" | "simulation"; prevHash: string; hash: string; signature: string;
}

type Body = Omit<LedgerEntry, "seq" | "hash" | "signature">;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const hashOf = (b: Body): string => sha(canonicalJson({ ...b }));
const sign = (key: string, hash: string): string => createHmac("sha256", key).update(`vs-ledger:v1:${hash}`).digest("base64url");

function rowToEntry(r: Record<string, unknown>): LedgerEntry {
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(String(r.payload)) as Record<string, unknown>; } catch { /* reported by verify */ }
  return {
    seq: Number(r.seq), entryId: String(r.entry_id), ts: Number(r.ts), kind: String(r.kind) as LedgerKind, subjectType: String(r.subject_type) as SubjectType, subjectId: String(r.subject_id),
    actor: String(r.actor), summary: String(r.summary), payload, refSeq: r.ref_seq === null ? null : Number(r.ref_seq), source: r.source === "simulation" ? "simulation" : "real",
    prevHash: String(r.prev_hash), hash: String(r.hash), signature: String(r.signature),
  };
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const SAFE_ID = /^[\w.:-]{1,64}$/;

export interface NewEntry { kind: LedgerKind; subjectType: SubjectType; subjectId: string; actor: string; summary: string; payload?: Record<string, unknown>; refSeq?: number | null; source?: "real" | "simulation" }

export function appendEntry(ctx: Ctx, e: NewEntry): LedgerEntry {
  if (!SAFE_ID.test(e.subjectId) && e.subjectType !== "system") throw new HttpError(400, "validation_failed", "subjectId is malformed");
  return ctx.db.tx(() => {
    const last = ctx.db.get("SELECT hash FROM ledger_entries ORDER BY seq DESC LIMIT 1");
    const body: Body = {
      entryId: randomUUID(), ts: ctx.now(), kind: e.kind, subjectType: e.subjectType, subjectId: e.subjectId, actor: clip(e.actor || "admin", 64), summary: clip(e.summary, 400),
      payload: e.payload ?? {}, refSeq: e.refSeq ?? null, source: e.source ?? "real", prevHash: last ? String(last.hash) : GENESIS,
    };
    const hash = hashOf(body);
    const signature = sign(ctx.cfg.ledgerKeys[0]!, hash);
    const r = ctx.db.run(
      "INSERT INTO ledger_entries (entry_id, ts, kind, subject_type, subject_id, actor, summary, payload, ref_seq, source, prev_hash, hash, signature) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      body.entryId, body.ts, body.kind, body.subjectType, body.subjectId, body.actor, body.summary, canonicalJson(body.payload), body.refSeq, body.source, body.prevHash, hash, signature,
    );
    return { seq: r.lastInsertRowid, ...body, hash, signature };
  });
}

/** Best-effort capture from existing flows. A ledger failure must never undo the action it records, but it is never silent. */
export function record(ctx: Ctx, e: NewEntry): void {
  try { appendEntry(ctx, e); } catch (err) { console.error(JSON.stringify({ msg: "ledger.append_failed", kind: e.kind, error: String(err) })); }
}

export interface ListOpts { subjectType?: string; subjectId?: string; kind?: string; limit?: number; beforeSeq?: number }

export function listEntries(ctx: Ctx, o: ListOpts = {}): LedgerEntry[] {
  const where: string[] = [], params: (string | number)[] = [];
  if (o.subjectType) { where.push("subject_type = ?"); params.push(o.subjectType); }
  if (o.subjectId) { where.push("subject_id = ?"); params.push(o.subjectId); }
  if (o.kind) { where.push("kind = ?"); params.push(o.kind); }
  if (o.beforeSeq) { where.push("seq < ?"); params.push(o.beforeSeq); }
  const limit = Math.min(Math.max(o.limit ?? 50, 1), 500);
  return ctx.db.all(`SELECT * FROM ledger_entries ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`, ...params, limit).map(rowToEntry);
}

export function getEntry(ctx: Ctx, seq: number): LedgerEntry | null {
  const r = ctx.db.get("SELECT * FROM ledger_entries WHERE seq = ?", seq);
  return r ? rowToEntry(r) : null;
}

export interface Verification { ok: boolean; entries: number; head: string | null; firstBadSeq: number | null; reason: string | null; signaturesChecked: boolean }

/** Recomputes every hash and link. With `keys`, also checks each signature against any accepted key. */
export function verifyChain(entries: LedgerEntry[], keys: string[] | null): Verification {
  let prev = GENESIS;
  for (const e of entries) {
    if (e.prevHash !== prev) return { ok: false, entries: entries.length, head: null, firstBadSeq: e.seq, reason: "chain broken: previous hash does not match (an entry was removed, reordered or edited)", signaturesChecked: keys !== null };
    const { seq: _s, hash: _h, signature: _g, ...body } = e;
    if (hashOf(body) !== e.hash) return { ok: false, entries: entries.length, head: null, firstBadSeq: e.seq, reason: "content does not match its hash (entry was edited)", signaturesChecked: keys !== null };
    if (keys) {
      const given = Buffer.from(e.signature);
      const good = keys.some((k) => { const want = Buffer.from(sign(k, e.hash)); return want.length === given.length && timingSafeEqual(want, given); });
      if (!good) return { ok: false, entries: entries.length, head: null, firstBadSeq: e.seq, reason: "signature does not verify with any accepted ledger key (entry was forged or the key changed)", signaturesChecked: true };
    }
    prev = e.hash;
  }
  return { ok: true, entries: entries.length, head: entries.length ? prev : null, firstBadSeq: null, reason: null, signaturesChecked: keys !== null };
}

export function verifyLedger(ctx: Ctx): Verification {
  const all = ctx.db.all("SELECT * FROM ledger_entries ORDER BY seq ASC").map(rowToEntry);
  return verifyChain(all, ctx.cfg.ledgerKeys);
}

export function exportLedger(ctx: Ctx, o: { subjectType?: string; subjectId?: string } = {}): { exportedAt: number; head: string | null; entries: LedgerEntry[] } {
  // A filtered export cannot be chain-verified on its own; the unfiltered export can.
  const rows = ctx.db.all("SELECT * FROM ledger_entries ORDER BY seq ASC").map(rowToEntry);
  const entries = rows.filter((e) => (!o.subjectType || e.subjectType === o.subjectType) && (!o.subjectId || e.subjectId === o.subjectId));
  return { exportedAt: ctx.now(), head: rows.length ? rows[rows.length - 1]!.hash : null, entries };
}

/* ------------------------------------------------------------------ decisions */

export interface DecisionState { proposal: LedgerEntry; resolution: LedgerEntry | null; status: "proposed" | "approved" | "rejected" }

export function decisionsFor(ctx: Ctx, subjectType: string, subjectId: string): DecisionState[] {
  const rows = ctx.db.all("SELECT * FROM ledger_entries WHERE subject_type = ? AND subject_id = ? AND kind IN ('decision.proposed','decision.approved','decision.rejected') ORDER BY seq ASC", subjectType, subjectId).map(rowToEntry);
  const proposals = rows.filter((r) => r.kind === "decision.proposed");
  return proposals.map((p) => {
    const res = rows.find((r) => r.refSeq === p.seq && r.kind !== "decision.proposed") ?? null;
    return { proposal: p, resolution: res, status: res ? (res.kind === "decision.approved" ? "approved" : "rejected") : "proposed" };
  });
}

export function latestOfficialDecision(ctx: Ctx, subjectType: string, subjectId: string): DecisionState | null {
  const approved = decisionsFor(ctx, subjectType, subjectId).filter((d) => d.status === "approved");
  return approved.length ? approved[approved.length - 1]! : null;
}

export interface Snapshot { fingerprint: string; facts: Record<string, unknown>; generatedAt: number }

export function proposeDecision(ctx: Ctx, a: { subjectType: SubjectType; subjectId: string; decision: unknown; rationale: unknown; actor: string; snapshot: Snapshot; source: "real" | "simulation" }): LedgerEntry {
  if (!DECISIONS.includes(a.decision as Decision)) throw new HttpError(400, "validation_failed", `decision must be one of ${DECISIONS.join(", ")}`);
  if (typeof a.rationale !== "string" || a.rationale.trim().length < 10) throw new HttpError(400, "validation_failed", "rationale is required (at least 10 characters): say why, for whoever reads this later");
  if (a.rationale.length > 2000) throw new HttpError(400, "validation_failed", "rationale must be at most 2000 characters");
  const dec = a.decision as Decision;
  return appendEntry(ctx, {
    kind: "decision.proposed", subjectType: a.subjectType, subjectId: a.subjectId, actor: a.actor, source: a.source,
    summary: `Proposed: ${dec.toUpperCase()}. ${clip(a.rationale.trim(), 200)}`,
    payload: { decision: dec, rationale: a.rationale.trim(), snapshot: a.snapshot },
  });
}

export function expectedResolution(action: "approve" | "reject", seq: number): string { return `${action.toUpperCase()} ${seq}`; }

export function resolveDecision(ctx: Ctx, a: { seq: number; action: "approve" | "reject"; actor: string; confirmation: unknown; reason: unknown; acknowledgeChanges: boolean; current: Snapshot; changes: unknown[] }): LedgerEntry {
  const p = getEntry(ctx, a.seq);
  if (!p || p.kind !== "decision.proposed") throw new HttpError(404, "decision_not_found", "No such proposed decision");
  if (a.confirmation !== expectedResolution(a.action, a.seq)) throw new HttpError(400, "confirmation_required", `Type exactly "${expectedResolution(a.action, a.seq)}" to confirm`);
  if (typeof a.reason !== "string" || a.reason.trim().length < 5) throw new HttpError(400, "validation_failed", "A reason is required (at least 5 characters)");
  if (decisionsFor(ctx, p.subjectType, p.subjectId).find((d) => d.proposal.seq === p.seq)?.resolution) throw new HttpError(409, "already_resolved", "This proposal was already approved or rejected");
  if (a.action === "approve" && !ctx.cfg.allowSelfApproval && p.actor === a.actor) {
    throw new HttpError(403, "self_approval_forbidden", "A decision needs a second named actor to become official. Approve as a different actor (X-VariantShield-Actor), or set VARIANTSHIELD_ALLOW_SELF_APPROVAL=true for a single-operator instance.");
  }
  const snap = p.payload.snapshot as Snapshot | undefined;
  const changed = a.action === "approve" && snap !== undefined && snap.fingerprint !== a.current.fingerprint;
  if (changed && !a.acknowledgeChanges) throw new HttpError(409, "context_changed", "The facts this decision was based on have changed since it was proposed. Review the changes and approve again with acknowledgeChanges.", { changes: a.changes });
  return appendEntry(ctx, {
    kind: a.action === "approve" ? "decision.approved" : "decision.rejected", subjectType: p.subjectType, subjectId: p.subjectId, actor: a.actor, refSeq: p.seq, source: p.source,
    summary: `${a.action === "approve" ? "Approved" : "Rejected"} #${p.seq}: ${String(p.payload.decision ?? "").toUpperCase()}. ${clip(a.reason.trim(), 200)}`,
    payload: { decision: p.payload.decision, rationale: p.payload.rationale, reason: a.reason.trim(), proposedBy: p.actor, snapshot: snap ?? a.current, approvedOnChangedContext: changed, currentAtResolution: a.current },
  });
}
