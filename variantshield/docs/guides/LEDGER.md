# Decision ledger, context and assistant

One place that remembers **what was known, what was decided, by whom, and what has changed since**, for each experiment plan and each cross-surface contract. Open it from the dashboard (**Decision Ledger**), the CLI (`variantshield ledger ...`) or an MCP client ([MCP.md](MCP.md)).

"Official" here means one specific thing: a decision that one person proposed and a different person approved in this ledger. It does not make VariantShield an official Flagsmith product; it is an independent community project.

## The workflow

1. **Experiments run.** Flagsmith assigns variants and computes its result. VariantShield adds the reliability verdict and, if a contract covers the same flag, the cross-surface status.
2. **Facts are captured as they happen.** Plan approval changes, evidence snapshots, executed pause/resume/complete actions, contract registrations and contract status changes append ledger entries automatically. Dry runs and refusals stay in the audit table.
3. **Someone asks.** The assistant answers from the stored records, with citations. "Should we ship this?" produces a **draft** (ship, hold, pause, rollback or extend) with a rationale.
4. **A person proposes.** They record the draft, or their own decision, with a rationale. The proposal stores a snapshot of the facts it was based on and a fingerprint of them.
5. **A different person approves.** They type `APPROVE <n>`, give a reason, and the decision becomes official. The same person cannot approve their own proposal (unless `VARIANTSHIELD_ALLOW_SELF_APPROVAL=true` on a single-operator instance). Rejecting is allowed for anyone.
6. **Staleness is explicit.** If the fingerprint changed between proposal and approval, approval is refused with the list of changes until the approver acknowledges them, and the entry records `approvedOnChangedContext: true`.
7. **Later, "what changed?"** compares today's facts with the snapshot stored in the last official decision and lists exactly which facts moved.

Acting on a decision (pausing in Flagsmith) is still the separate, human-confirmed **Experiment Control** flow. An official decision does not trigger anything.

## What is stored

Every entry has a sequence number, time, kind, subject (plan or contract), actor, summary, payload, source (`real` or `simulation`), the previous hash, its own hash and an HMAC signature.

| Kind | Written when |
|---|---|
| `plan.approval` | A plan's approval status changes |
| `evidence.snapshot` | An evidence snapshot is captured |
| `control.executed` | Pause, resume or complete actually changed Flagsmith (or a simulated plan) |
| `contract.registered` | A new contract version is registered (real contracts only) |
| `contract.checked` | A contract check finds a status different from the last recorded one |
| `decision.proposed`, `decision.approved`, `decision.rejected` | The decision flow above |
| `note` | A person adds a note |

Simulated plans are recorded with `source: simulation` and shown with a SIM chip, so a rehearsal cannot pass as a real decision.

## Integrity

* **Append-only.** Database triggers refuse `UPDATE` and `DELETE` on the table.
* **Hash chain.** Each hash covers the entry and the previous hash. Editing or removing an entry in the middle breaks every hash after it.
* **Signed.** Each hash is signed with an HMAC key kept on the server (`VARIANTSHIELD_LEDGER_KEY`, derived from the identity secret if unset). Someone who can only write the database file cannot produce a chain that verifies.
* **Verify:** `variantshield ledger verify` (online, checks signatures), the dashboard's **Verify now**, `GET /api/ledger/verify`, or offline with `variantshield ledger export --out l.json` then `variantshield ledger verify --file l.json` (chain only).
* **Key rotation:** put the new key in `VARIANTSHIELD_LEDGER_KEY` and keep the old one in `VARIANTSHIELD_LEDGER_KEY_PREVIOUS` so old entries still verify.

What it cannot detect: **removal of the newest entries** (nothing later refers to them). Store the `head` hash somewhere else (the export and verify output print it) and check it with `--expect-head`. The `actor` is the name sent by the caller, so it is as trustworthy as the admin credential; put SSO in front for real attribution. The ledger is never purged by retention.

## The assistant

Rule-based. No model, no network, nothing leaves the server. A fixed set of patterns maps a question to one of these intents, and the answer is built from the context brief only:

| Ask | Intent |
|---|---|
| "What is the current status?" | `status` |
| "Should we ship this?" / "safe to roll out?" | `recommend` (a draft, never recorded) |
| "What changed since the last decision?" | `changes` |
| "Why was it paused?" | `why` |
| "Who approved the current decision?" | `decision` |
| "What are the open risks?" | `risks` |
| "Show the history" | `history` |
| "Is the ledger intact?" | `integrity` |
| "Explain BREACH" / "what is WINNER_BUT_UNSAFE" | `explain` |

Anything else gets "I do not guess" and a list of questions it can answer. Every answer lists its citations (ledger entry numbers, finding keys, fact names). The recommendation rules, in order: a failed ledger verification or a contract violation means **hold**; `WINNER_BUT_UNSAFE` means **pause**; `REQUIRES_INVESTIGATION` means **hold**; insufficient or inconclusive evidence means **extend**; `WINNER_AND_SAFE` means **ship** (and says so when no contract covers the flag). These are policy defaults, not statistics; the people deciding own the decision.

The viewer token may read and ask. Recording, approving and rejecting need the admin token.

## The context brief

`GET /api/context/plan/<id>` and `/contract/<id>` return the object everything else reads: current verdicts and statuses, the official decision, pending proposals (flagged stale when facts moved), what changed since the official decision, open questions and recent entries. A plan includes the contracts whose assignment flag equals the plan's feature key. `fingerprint` is a hash of only the facts a decision depends on, so it changes when the outcome, reliability status, per-variant status, Flagsmith status, plan approval or a linked contract's status changes, and not when a timestamp does.
