# MCP Server

Exposes one tool — `record_decisions` — over the Model Context Protocol so Claude Code can write decisions into the project's code graph. Each call records one or more decisions in an atomic batch. Write-only; reads go through SQLite directly or await a later layer.

## Prerequisite

The project must be indexed before the MCP server will start:

```bash
context-chain index /path/to/project
```

The server exits with code 1 if `<project-root>/.ctx/graph.db` does not exist. It does **not** check whether the index contains any nodes — a decision can be recorded against a file in an otherwise empty repo (legitimate when anchoring at file level on a types-only or config-only codebase).

## Claude Code setup

Add the server to `~/.claude/settings.json` (or project-local `.claude/settings.json`):

```jsonc
{
  "mcp": {
    "servers": {
      "context-chain": {
        "command": "node",
        "args": [
          "/absolute/path/to/context-chain/dist/src/mcp.js",
          "/absolute/path/to/your/project"
        ],
        "env": {
          "CONTEXT_CHAIN_SESSION_ID": "optional-id-if-you-want-sessions-tracked"
        }
      }
    }
  }
}
```

The `command` and `args` above run the server directly from the built source. If you install the package globally (`npm install -g context-chain`), an alternative is a separate `context-chain-mcp` bin — not shipped yet, tracked as future work.

## Permission modes

Claude Code's per-tool permission controls whether writes require user approval. There is no flag in the MCP server itself — the choice lives entirely in the client's settings.

**Autonomous writes** (Claude records when it judges a decision was made):

```jsonc
"permissions": {
  "allow": ["mcp__context-chain__record_decisions"]
}
```

**Explicit approval** (every write prompts the user):

```jsonc
"permissions": {
  "ask": ["mcp__context-chain__record_decisions"]
}
```

The `ask` mode is the appropriate default for sessions where decisions should not accumulate silently. `allow` is useful once user and Claude have a shared sense of what gets recorded.

## The `record_decisions` tool

A "decision" is an **alert** to future AI working in this codebase about a semantically important situation that grep cannot find — implicit ordering, historical landmines, cross-file coupling, intentional absences, non-obvious distinctions, temporal state. Not documentation, not TODOs, not bug notes.

The tool takes a **batch** of decisions and commits them atomically. A single conversation commonly surfaces multiple decisions at once; batching saves roundtrips and keeps them together in one transaction.

Input schema (JSON):

```json
{
  "decisions": [
    {
      "decision": "WAL mode is required: hooks read while indexer writes",
      "keywords": ["concurrency", "storage"],
      "anchors": [
        { "kind": "function", "file": "src/db.ts", "name": "openDatabase" }
      ]
    },
    {
      "decision": "src/retry.ts is the single retry implementation; do not add another",
      "keywords": ["retry"],
      "anchors": [
        { "kind": "file", "file": "src/retry.ts" }
      ]
    }
  ]
}
```

- `decisions` must have at least one entry; no upper bound
- Each decision: `decision` (required, one terse sentence), `keywords` (non-empty array), `anchors` (non-empty array)
- Each keyword: lowercase ASCII, starts with letter, ends with letter/digit, `[a-z0-9-]` in between, length 2-40 (regex `^[a-z][a-z0-9-]{0,38}[a-z0-9]$`). Examples: `retry`, `legacy-fallback`, `billing-flow`. Rejected: `Retry`, `重试`, `retry!`, `a`, `abc-`. Duplicates within a single decision are rejected.
- Each anchor has `kind` of either `'function'` or `'file'`
- `kind: 'function'` requires a `name`
- `kind: 'file'` must NOT include a `name` field

Paths are normalized to POSIX (`/`) at write time; callers may pass either separator.

Successful response: `recorded N decisions (ids: id1, id2, ...); anchors live: X/Y`. The `live/total` segment lets the caller self-check anchor typos in one round-trip — `live: 0/2` means both anchors point at code the indexer doesn't know about (typo, file moved, or aspirational anchor for code not yet written).

## Keyword vocabulary

Keywords group decisions semantically and need NOT appear in the decision text — use them for business concepts (`billing-flow`) or cross-cutting topics (`retry`).

The server tracks all keywords in the `decision_keywords` table. At server **startup**, existing keywords are sorted by frequency desc (alphabetical tie-break) and injected into the tool description so the next session sees them. The agent is prompted to reuse existing keywords and introduce new ones only for genuinely new concepts.

The vocab is dumped in full when there are ≤100 distinct keywords; above that, only the top 100 are surfaced (with a `top 100 of N` hint). No internal normalization, no LLM, no synonym detection — `redo` and `retry` will fragment unless the agent disciplines itself based on the description. Vocab updates require a server restart to take effect.

## Error behavior

Two distinct error channels:

**Tool response with `isError: true`** — the tool ran but rejected the input. Claude sees the message and can correct and retry. Triggers:

- `decisions` missing / not an array / empty
- Any decision missing `decision` (the alert text)
- Any decision with missing, non-array, or empty `anchors`
- Any decision with missing, non-array, or empty `keywords`
- Any keyword that is non-string, fails the format regex, or duplicates another keyword in the same decision
- Any anchor missing `file`, or with `file` non-string / empty
- Any anchor with invalid `kind`
- Any `kind: 'function'` anchor without `name`
- Any `kind: 'file'` anchor with `name` present

**Errors accumulate across the whole batch.** If decisions[0], [1], and [3] each have different validation problems (and [2] is fine), the single response lists all three, one per line, prefixed by their JSON path:

```
decisions[0].summary must be a non-empty string
decisions[1].anchors[0].kind must be 'function' or 'file'
decisions[3].anchors[0].name required when kind='function'
```

Claude corrects all of them in one retry rather than fixing one at a time. A hostile or malformed input that would produce thousands of errors is capped at 50 lines with a trailing `... and N more` so the tool response stays bounded.

**Atomicity:** if any validation fails, no decisions in the batch are written — even the ones that were individually valid. Partial commits never happen.

**JSON-RPC protocol error** — something outside input handling failed. Claude Code treats this as "the tool is broken". Triggers:

- Database write fails
- Unexpected runtime error in the handler

The distinction matters because Claude recovers gracefully from the first (retry with corrected args) but usually cannot recover from the second (session may degrade).

## Session ID

If the environment variable `CONTEXT_CHAIN_SESSION_ID` is set when the server starts, decisions recorded by that instance will carry its value in the `session_id` column. There is no reader for this field — it's stored for future tooling (session-level rollback, audit, grouping). Claude Code does not currently inject a session identifier into MCP subprocess env; when it does, switch to whatever variable name ships and update this doc.

## What this server deliberately does not do

- **No read tools.** `list_decisions`, `get_callers`, graph traversal — all deferred to a later read layer. Users wanting to inspect decisions today can query `.ctx/graph.db` directly with `sqlite3`.
- **No CLI write path.** `context-chain decide ...` would duplicate the MCP surface with worse shell-escaping. MCP is the only sanctioned write channel.
- **No automatic keyword normalization** beyond format validation. No stemming, no synonym detection, no LLM call. Vocab discipline is socially enforced via the description's "reuse existing keywords" prompt.
- **No multi-project concurrency.** One server instance serves one project directory. Running two Claude Code projects in parallel requires two MCP server entries in settings.
- **No project root auto-detection.** The project path is the second CLI argument; the server does not walk up from the CWD looking for `.ctx/`. Explicit is better.
- **No dry-run or preview mode.** The same behavior is achieved with Claude Code's `permissions.ask` — every call prompts for approval before execution.

## Troubleshooting

**Server exits immediately with "no index at ..."**
Run `context-chain index <same-path>` first. The path shown in the error should match the `args[1]` in your settings.

**Claude Code says the tool is unavailable**
Check that `node` resolves on PATH for the MCP subprocess. If Claude Code runs as a desktop app with no shell profile, use the absolute path: `"command": "/usr/local/bin/node"`.

**Tool response shows `anchors live: 0/N` (or anything less than `N/N`)**
Some anchor in the batch points at code the indexer doesn't know about. Either:

- The function was renamed/moved — re-run `context-chain index` so the registry catches up
- A typo in `file` or `name` — fix and re-record
- The anchor was always aspirational (recording a decision before writing the code) — this is fine; the next index after the function exists will reconcile (`anchors live` is computed on read, not stored)

**Want to inspect what was recorded**
Until the read layer ships:

```bash
sqlite3 /path/to/project/.ctx/graph.db \
  "SELECT d.id, d.decision, a.anchor_kind, a.anchor_file, a.anchor_name,
          (SELECT GROUP_CONCAT(keyword, ',') FROM decision_keywords k WHERE k.decision_id = d.id) AS keywords
   FROM decisions d JOIN decision_anchors a ON a.decision_id = d.id
   ORDER BY d.created_at DESC LIMIT 20;"
```
