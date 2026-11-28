# Task plan: Toggle Wars build (started 2026-11-26, after the 08:00 IST opening)

## Request (user, 2026-11-26)
- Take VariantShield to a full, novel implementation: complete structure, premium design, everything dynamic (no static data).
- Inherit ideas from a "DIBS main" zip. NOT RECEIVED: `/mnt/user-data/uploads` is empty, no repository named dibs is reachable, no computer folder is attached. Same methodology: multi-agent swarm.
- Toggle Wars (Flagsmith x WeMakeDevs, 26-29 Nov 2026, closes 20:00 IST on 29 Nov) opened today. "Arise something more niche."

## Hackathon facts (https://www.wemakedevs.org/hackathons/flagsmith, read 2026-11-26)
- Tracks: 01 Test Something Real ($2k), 02 AI Agents and Feature Flags ($1k; Flagsmith CLI/API/MCP, saves real time, a human approves changes, clear output), 03 Build on Open Source Flagsmith (PS5; self-hosted, integrations/plugins, developer tools, easy to reuse), 04 Agent Skills ($500; whole job, token efficiency, CLI, safety around production changes).
- Scorecard: use of Flagsmith, impact, creativity, demo video.
- Track 02 tip: "The interesting part is deciding what the agent does on its own and where it stops to ask a person."
- Track 04 idea: "Put out the fire: trace a broken feature to its flag, kill it, leave a trail for the follow-up".
- The user's own brief (23 Nov) says main coding must begin after the opening. Existing VariantShield code predates it; new work must be clearly identifiable.

## Constraints
- Repository: `victrvondoom/flagsmith` (a fork of the Flagsmith monorepo). Project lives in `variantshield/`. Branch `vsrupeshkumar/zealous-newton-5mhe7m`, draft PR #1.
- Flagsmith's own source is in `/home/user/flagsmith/api` (Django). Use it to verify every endpoint; never invent one.
- Stack: Node 22 type stripping (erasable TS, `.ts` imports), `node:test`, `node:sqlite`, `tsc --noEmit` strict, ESLint; dashboard is vanilla JS with a strict CSP and no build step. Runtime deps: `yaml` only; `playwright` dev only.
- Rule-based only, no LLM (the user's earlier decision).
- Every Flagsmith write happens inside an envelope a human approved; the final production-wide action needs a second person (existing ledger two-person rule).

## Candidate niche: Flag Bisect (working name)
A regression starts shortly after several flag changes. Today teams roll everything back, or guess. Instead:
1. Build a counterfactual on demand: a small canary cohort (a Flagsmith segment on a trait) gets a subset of the suspect changes reverted through segment overrides; everyone else is untouched.
2. Measure canary against the main population, decide with a sequential test.
3. Choose the next subset with a probabilistic (Bayesian) group-testing planner seeded with evidence-based priors; fall back to delta debugging (ddmin) when only a combination of changes breaks.
4. A deterministic agent swarm does the work on a shared blackboard (Sentinel, Archivist, Profiler, Prober, Judge, Guardian, Scribe), within the approved envelope. Killing the culprit for everyone needs a second person.

## Phases
- A. Investigation (parallel): Flagsmith API capabilities, prior art, dashboard audit, VariantShield integration map.
- B. Decisions -> `.agent/decisions.md`.
- C. Implementation.
- D. Independent verification -> `.agent/verification.md`.
