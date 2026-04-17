# Consumption Layer

How decisions reach the agent in a Claude Code session: a `Read` hook auto-injects relevant decisions for the file being read; two MCP read tools (`reset_decision_cache`, `decisions_by_keyword`) handle compaction recovery and topic-focused queries.

## Prerequisite

The project must be indexed:

```bash
context-chain index /path/to/project
```

This creates `.ctx/graph.db`. Decisions written via `record_decisions` land there; the consumption layer reads from the same file.

## Setup

Add to `~/.claude/settings.json` (or project-local `.claude/settings.json`):

```jsonc
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Read",
        "hooks": [{ "type": "command", "command": "context-chain inject" }] }
    ],
    "PostCompact": [
      { "matcher": "*",
        "hooks": [{ "type": "command", "command": "context-chain clear-shown" }] }
    ],
    "SessionEnd": [
      { "matcher": "*",
        "hooks": [{ "type": "command", "command": "context-chain delete-state" }] }
    ]
  },
  "mcp": {
    "servers": {
      "context-chain": {
        "command": "node",
        "args": ["/abs/path/to/context-chain/dist/src/mcp.js", "/abs/path/to/your/project"]
      }
    }
  }
}
```

The hook commands run synchronously and read JSON from stdin (Claude Code provides `tool_input.file_path`, `session_id`, `cwd`). If `context-chain` isn't on PATH for the Claude Code subprocess (common on macOS desktop builds), use the absolute path: `/usr/local/bin/context-chain` or wherever `npm install -g context-chain` placed it.

## Flow

### First Read of a file

1. Agent calls `Read("src/foo.ts")`.
2. Claude Code fires `PreToolUse` hook → `context-chain inject` runs with stdin JSON.
3. `inject` queries `decisionsForFile("src/foo.ts")`, partitions into new vs. previously shown.
4. Output is JSON with `additionalContext` injected into the agent's prompt:

```
[context-chain] 5 decisions on src/foo.ts (3 new, 2 shown earlier)

NEW:
file-level:
  [v1-migration] don't add another retry path here
fn bar():
  [retry] retry=1 intentional, was 3 (see incident 2025-03)
  [billing-flow] field order parsed externally

(2 decisions on this file already shown earlier this session.
If your context was compacted/summarized, call mcp__context-chain__reset_decision_cache.)
```

5. State file `.ctx/sessions/<session_id>.json` updated with the now-shown decision ids.
6. Read proceeds; agent sees file contents + injected decisions.

### Re-Read of same file (no compaction)

Same flow, but all decisions for this file are already in state — `inject` outputs the short hint instead:

```
[context-chain] 3 decisions on src/foo.ts shown earlier this session.
(call mcp__context-chain__reset_decision_cache if context was compacted)
```

### Cross-file decision

A decision anchored to multiple files is shown once per session, on the first file Read. Subsequent Reads of other anchored files don't re-show it. Cost: token efficiency. Trade: agent may miss the cross-cutting nature unless it remembers.

### Context compaction (auto or `/compact`)

`PostCompact` hook fires → `context-chain clear-shown` → state file wiped to empty array. The next file Read re-injects all relevant decisions (including ones shown before the compact).

### `/rewind summarize` or silent tool-output drop

Neither fires `PostCompact`. If the agent senses lost context (file content it expected isn't visible), it should call:

```
mcp__context-chain__reset_decision_cache
```

The MCP server has no reliable session_id (Claude Code doesn't inject one into the MCP subprocess env), so it wipes ALL session state files for the project. Other concurrent sessions get redundant re-injection on next Read — token waste, not a correctness bug.

### Session end / `/clear`

`SessionEnd` hook fires → `context-chain delete-state` → unlinks the named state file AND any state file with mtime > 7 days (orphan GC for `/clear` cases that don't fire SessionEnd).

## MCP read tools

### `reset_decision_cache`

No parameters. Wipes all `.ctx/sessions/*.json`. Returns `"decision cache reset (N session files wiped)"`.

Call when:
- Context was compacted (auto or `/compact`) — but the `PostCompact` hook should already have done this; reset is the belt to that suspenders
- `/rewind summarize` was used
- You sense earlier file contents are no longer in your context

### `decisions_by_keyword(keyword: string)`

Returns up to 50 decisions tagged with the given keyword, with text + anchors + other keywords + anchor liveness:

```
3 decisions tagged "retry":

#12 [retry, billing-flow] retry=1 intentional, was 3 (see incident 2025-03)
  anchors:
    function src/foo.ts::bar (live)
    file src/foo.ts (live)

#13 [retry] don't add another retry path here
  anchors:
    file src/foo.ts (live)

#28 [retry] format coupled to external system
  anchors:
    function src/legacy.ts::handler (dead)
```

`(live)` means the anchored function/file currently exists in the indexed graph. `(dead)` means it was renamed/moved/deleted, or the anchor was always aspirational. Above 50 results: `"50 of N shown; refine the keyword"` footer.

## State file

Path: `<project>/.ctx/sessions/<session_id>.json`

Shape: `{ "shown_decision_ids": [12, 13, 14] }`

Only the dedupe set; no timestamps, no per-file breakdown. A given decision id appears once across the whole session regardless of how many files it's anchored to.

## What this layer deliberately does NOT do

- **No Edit/Write hooks.** Agents almost always Read before editing; one matcher covers the realistic case.
- **No `UserPromptSubmit` keyword sniffing.** Substring matching against vocab is brittle ("retries" doesn't match "retry"; Chinese doesn't match English).
- **No cross-file thematic surfacing** via keyword overlap. Token explosion risk; broad keywords pull dozens of unrelated decisions.
- **No file-level lock on state writes.** Parallel Reads race; loss is "marked shown" entries → redundant re-injection. Token waste, not correctness.
- **No `install-hooks` CLI subcommand.** Doc shows the snippet; users copy.
- **No dedicated `reason` parameter on `reset_decision_cache`.** Telemetry is the only use case; v1 doesn't need it.

## Troubleshooting

**Hook doesn't fire**
- `.claude/settings.json` is valid JSON
- `context-chain` resolves on PATH for Claude Code subprocesses; if not, use absolute path

**Inject produces no output but file has decisions**
- File path is outside the project root (CWD mismatch)
- `.ctx/graph.db` doesn't exist at `<cwd>/.ctx/graph.db` — re-index
- All decisions for this file already shown this session (run `reset_decision_cache` to verify by re-Reading)

**`anchors live: 0/N` after writing decisions**
- Function was renamed/moved — re-run `context-chain index`
- Anchor was aspirational (function not yet written) — fine; flips to live after next index

**Inject is slow (>100ms)**
- Indices missing — verify `idx_decision_keywords` and `idx_decision_anchors_lookup` exist:
  ```bash
  sqlite3 .ctx/graph.db ".indices"
  ```

**State files accumulate in `.ctx/sessions/`**
- `/clear` doesn't fire `SessionEnd`; orphan GC in `delete-state` (>7 days mtime) cleans them on the next end. To wipe manually: `rm .ctx/sessions/*.json`.
