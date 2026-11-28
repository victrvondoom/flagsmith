# MCP server

Lets an assistant such as Claude Code read the same preserved context the dashboard shows, ask the rule-based assistant, and, only if you enable it, record a **proposal**. It cannot approve a decision, pause an experiment or change anything else.

VariantShield is an independent community project, not an official Flagsmith product.

## Set up

Create a read-only token on the server (`VARIANTSHIELD_VIEWER_TOKEN`, 16+ characters), then register the server with your client. For Claude Code:

```bash
claude mcp add variantshield \
  --env VARIANTSHIELD_URL=http://127.0.0.1:8787 \
  --env VARIANTSHIELD_MCP_TOKEN=<viewer token> \
  -- node /path/to/variantshield/apps/mcp/src/main.ts
```

Or a project `.mcp.json` (see [`examples/mcp.json`](../../examples/mcp.json)). Node 22.18 or newer, no extra dependencies. The server speaks newline-delimited JSON-RPC over stdio (protocol versions 2025-06-18, 2025-03-26 and 2024-11-05) and writes only protocol messages to stdout.

| Variable | Meaning |
|---|---|
| `VARIANTSHIELD_URL` | API address, default `http://127.0.0.1:8787` |
| `VARIANTSHIELD_MCP_TOKEN` | Viewer token (recommended) or admin token. Required |
| `VARIANTSHIELD_MCP_ALLOW_PROPOSE` | `true` exposes `propose_decision`. Needs an admin token |
| `VARIANTSHIELD_MCP_ACTOR` | Name recorded on proposals, default `mcp-assistant` |

## Tools

| Tool | Does |
|---|---|
| `list_subjects` | Plans and contracts you can ask about |
| `get_context` | The context brief for a plan or contract |
| `ask` | A rule-based answer with citations, optionally with a drafted decision (not recorded) |
| `list_ledger` | Recent ledger entries, filterable |
| `verify_ledger` | Recomputes the hash chain and signatures |
| `propose_decision` | Off by default. Records a PROPOSED decision. A different person must approve it in the dashboard |

All read tools are marked `readOnlyHint`. There is no approve, reject, pause or control tool.

## Why you can leave it connected

* **Least privilege.** A viewer token cannot write: the API answers 403 even if the tool is enabled.
* **Proposals are not decisions.** `propose_decision` creates a `decision.proposed` entry attributed to the MCP actor; it becomes official only after a human approves it, and a proposer cannot approve their own.
* **Output is data, not instructions.** Plan titles, notes and finding messages are written by people and systems. Every result carries a notice saying so, control and bidirectional-override characters are stripped, strings are capped at 4000 characters, arrays at 500 items and depth at 12. This reduces prompt-injection risk; it cannot remove it, so keep the tool list short and the token read-only.
* **Bounded.** Messages over 1 MiB are refused, each API call times out after 20 s, and the usual rate limits apply.
