# DRAFT, NOT PUBLISHED. Needs the owner's approval before posting anywhere.

**Where it would go:** a GitHub Discussion (Ideas) on `Flagsmith/flagsmith`, not a pull request. VariantShield works through Flagsmith's public APIs and changes nothing in Flagsmith, so there is no code to propose upstream unless the maintainers want to adopt part of the idea.

**Title:** Experiment decision records: who decided what, on which evidence, and what changed since

**Disclosure:** VariantShield is an independent community project. It is not an official Flagsmith product and is not endorsed by Flagsmith. "Official decision" below means "approved by a second person in that tool's ledger", nothing more.

## The problem

Experiment results are time-sensitive: the status, the winner and the guardrails move. Teams decide ("ship the winner", "pause it") on one day's evidence, and weeks later nobody can say what the evidence was, who agreed, or whether it still holds. Flagsmith's audit log records what changed in the system; it does not record a team's decision about an experiment or the facts it rested on.

## What the independent integration does

* Keeps an append-only, hash-chained, signed ledger of experiment events (approvals, evidence snapshots, executed pause/resume/complete, cross-surface contract status) and of **decisions**.
* A decision is proposed with a rationale and a snapshot of the facts it was based on, and becomes official only when a different person approves it. If the facts changed in between, approval needs an explicit acknowledgement.
* Later, it answers "what changed since the official decision?" by diffing current facts against that snapshot.
* A rule-based assistant (no model) answers from those records with citations, and an MCP server exposes the same read paths to coding assistants, read-only by default.
* Acting on a decision is still a separate human-confirmed step through Flagsmith's documented experiment endpoints.

Everything experimental stays in Flagsmith: assignment, exposure and conversion events, and the results.

## Questions for the maintainers (nothing here is assumed)

1. Is recording team decisions about experiments in scope for the product, or better left to integrations?
2. Is there, or is there planned, a webhook or audit-log event for experiment lifecycle changes (start, pause, complete) that an integration could subscribe to instead of polling?
3. Would a stable, documented way to read an experiment's results history (not just the latest) help integrations anchor evidence?
4. Is there a preferred place to list community integrations?

## What I am not asking for

No change to Flagsmith's code, no endorsement, and no use of Flagsmith's name beyond accurate description of compatibility.

## Evidence

Repository: the `variantshield/` directory of the author's fork. `docs/guides/LEDGER.md` describes the workflow and its limits (notably: removal of the newest ledger entries is only detectable if the head hash is stored elsewhere; the actor name is as trustworthy as the admin credential).
