# Decisions (Phase B)

1. Niche: incident attribution across several concurrent flag changes, by on-demand canary reverts. Prior art (findings-prior-art.md) found no product doing this; the planner itself is known (noisy bisection, FACF, ddmin) and is cited, not claimed.
2. Per-probe test: two-sample mSPRT instead of a Beta posterior stopping rule (no error control under repeated looks). Beta kept as a read-out.
3. Rule-based swarm (user's earlier "no LLM" decision): seven single-purpose agents on a SQLite blackboard, one tick loop.
4. Human gates where the hackathon tip asks: before any Flagsmith write (envelope) and before anything reaches everyone (two-person remediation). MCP gets read tools only.
5. Cohorts from the flags each request reports, not from re-implementing Flagsmith's hash.
6. Flagsmith writes through `/api/__future__/` PATCH (both versioning modes), never PUT.
7. Change history: watcher + webhook + audit (decided after the live run showed webhooks and audit unavailable on local OSS Flagsmith).
8. Dashboard: live updates via authenticated fetch stream (EventSource cannot send Bearer); design-system rewrite keeping every class and text the tests rely on.
9. DIBS zip not received; not guessed at.
