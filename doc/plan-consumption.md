# Plan: Consumption Layer — Push Hooks + MCP Read Tools

## Context

After Decision Capture rework shipped (`doc/plan-alert-keywords.md`), decisions sat in `.ctx/graph.db` but no agent ever saw them. The read side was empty. The project's stated differentiator is "decision capture via Claude Code hooks" — without an automatic injection path, the entire stack was write-only.

This rework added the consumption layer: a `Read` hook that injects relevant decisions for the file being read, plus two MCP read tools (`reset_decision_cache`, `decisions_by_keyword`).

## Push, not pull

Two paths could surface decisions on read:

- **Pull** — agent calls a query tool when curious. Reliable only if agent remembers; in practice, agents almost never query unprompted.
- **Push** — Claude Code hook auto-injects decisions when agent reads a file. Zero agent effort.

Push wins for the primary path. Pull stays as a secondary surface (`decisions_by_keyword`) for topic-focused queries the agent explicitly wants.

## Read-only matcher

Only `PreToolUse` matcher `Read` is hooked. Edit/Write deferred — agents almost always Read before editing, so Read covers the realistic case. Adding Edit/Write hooks would mostly produce duplicate injections in the common Read-then-Edit pattern.

## Per-session dedupe — and the compaction problem

A given decision is shown once per session, keyed by `decision_id` only (not `(file_id, decision_id)`). When a decision anchors multiple files, the agent sees it once across the whole session — token-efficient, since the alert itself is the same regardless of which file the agent read first.

State lives in `<project>/.ctx/sessions/<session_id>.json` with shape `{ "shown_decision_ids": [...] }`.

The hard problem: if the agent's context gets compacted/summarized after a decision was injected, the agent has lost that injection — but our state file still says "shown." Result: silent gap; agent never sees the decision again this session.

We researched all four ways context can shrink in Claude Code (auto-compact, manual `/compact`, `/clear`, `/rewind summarize`):

| Type | Hook | session_id |
|------|------|------------|
| Auto compact | PreCompact / PostCompact | unchanged |
| Manual `/compact` | PreCompact / PostCompact | unchanged |
| `/clear` | SessionEnd → SessionStart | **new** |
| `/rewind summarize` | **none** | unchanged |

Plus a documented but unhooked gap: auto-compact silently drops older tool outputs *before* the formal `PreCompact` event.

### Two-path recovery

We took belts + suspenders:

1. **`PostCompact` hook** — auto-clears state on auto/manual compact. Covers the most common case without agent involvement.
2. **`reset_decision_cache` MCP tool** — agent self-service for what hooks miss (`/rewind summarize`, silent tool-output drops).

Reason for both: we honestly cannot rely on agent self-detection alone. Compaction replaces conversation with summaries that look like normal messages — agents (including Claude itself, when asked) cannot reliably distinguish "I have this in context" from "I had this and lost it." Without the hook, the gap would be too wide. Without the agent tool, `/rewind summarize` and silent drops would be unrecoverable.

## `reset_decision_cache` design

No parameters. Wipes all `.ctx/sessions/*.json` for the project root.

Why no parameters: compaction is broad, not file-precise. "Wipe all" matches the agent's mental model.

Why all session files (not just the calling session): the MCP server has no reliable session_id — Claude Code does not inject a session env var into MCP subprocesses, and `.mcp.json` cannot dynamically supply one. Iterating all state files is the only correct implementation. Cost: another concurrent session (rare) gets redundant re-injection on its next Read. Token waste, not a correctness bug.

## Keyword consumption (read side)

Keywords were captured on write but unused on read. Four options were considered:

1. **Inline display** in injected text — every line prefixed `[kw1, kw2]` so agent can skim/filter
2. **Cross-file thematic surfacing** — when agent reads file A, also surface decisions from other files sharing keywords
3. **`UserPromptSubmit` keyword sniffing** — substring-match user prompt against vocab, push related decisions
4. **Pull tool** `decisions_by_keyword` — agent queries explicitly

Did 1 + 4. Skipped 2 (token explosion for common keywords like `retry`) and 3 (substring matching is brittle: "retries" doesn't match "retry"; cross-language fails).

`decisions_by_keyword` returns up to 50 results with full anchor info and `(live)` / `(dead)` liveness markers per anchor.

## Inject output format

Three branches:

- **Has new decisions** — full inline format grouped by anchor (file-level first, then per function), with footer mentioning previously shown count and pointing at `reset_decision_cache`.
- **All shown earlier** — short hint only, no decision text repeated.
- **No decisions** — exit 0 silent.

Same-file multi-anchor rule: if a decision has both file-level AND function-level anchors on the same file, show it once under `file-level:` (file-level scope subsumes the function-level claim). If a decision has multiple function anchors on the same file (no file-level), show it under each — distinct scope claims.

## 8K char cap

Claude Code documents `additionalContext` capped at ~10K chars. We leave 2K headroom and truncate the NEW section if formatted text exceeds 8K. **All decisions returned by `decisionsForFile` are marked shown** even when truncated, with a footer pointing the agent to `decisions_by_keyword`. Rotation across re-Reads was rejected: it only delays truncation; the cap exists because the file is decision-heavy and the user must shift to query mode.

## STEP 0 — schema fix

Critical prerequisite: `src/storage.ts` had three `DROP TABLE IF EXISTS` lines for `decisions`, `decision_anchors`, and `decision_nodes` left over from the schema break. Every `openDatabase()` re-ran them. Inject spawns a fresh node process per Read → openDatabase → DROPs → all decisions wiped before query. The hook would have found nothing.

Removing the three lines was Step 0 of this rework. Existing tests still pass after removal (they use `/tmp/` paths that get cleaned up explicitly).

## Files

```
src/storage.ts          MOD   Step 0: deleted 3 DROP lines
src/decisions.ts        MOD   added decisionsForFile, decisionsByKeyword,
                              keywordsForDecisions, anchorsForDecisions
src/session.ts          NEW   path + read/write/wipeAll/delete with mtime GC
src/inject.ts           NEW   runInject + format helpers
src/cli.ts              MOD   subcommands: inject, clear-shown, delete-state;
                              added require.main guard
src/mcp.ts              MOD   tools: reset_decision_cache, decisions_by_keyword
verify-inject.ts        NEW   16 scenarios
verify-mcp.ts           MOD   8 new scenarios (20-27)
package.json            MOD   verify script appends verify-inject.js
doc/consumption.md      NEW   user-facing setup + flow walkthrough
```

## Layer responsibilities after this rework

- **`storage.ts`** — DB lifecycle + schema. Knows nothing about sessions or hooks.
- **`decisions.ts`** — pure SQL operations on decisions/anchors/keywords.
- **`session.ts`** — state file path math + JSON shape, used by 4 callers.
- **`inject.ts`** — read-side query, dedupe, anchor grouping, output formatting.
- **`cli.ts`** — argv dispatch + stdin parsing for hook subcommands.
- **`mcp.ts`** — JSON-Schema, validation, request routing for all 3 MCP tools.

## What this rework deliberately does NOT do

- Hook on `Edit` / `Write` (Read covers the realistic case).
- `UserPromptSubmit` keyword sniffing (brittle).
- Cross-file thematic surfacing via keyword overlap (token explosion).
- File-level lock on state writes (concurrent Reads race; loss is "marked shown" → redundant re-injection, not corruption).
- `install-hooks` CLI helper (doc shows the snippet to copy).
- `reason` parameter on `reset_decision_cache` (telemetry only; doesn't need it).
- Read tools beyond two (`record_decisions`, `reset_decision_cache`, `decisions_by_keyword` — the per-tool MCP description tax keeps the surface small).
- Decision relationship graphs (out per CLAUDE.md).

## Known unfixed gaps

- **Concurrent inject race** — parallel Reads on the same session lose "marked shown" entries. acceptable; fix path: write to `<id>.json.tmp` + atomic rename.
- **Silent tool-output drop before auto-compact** — Claude Code drops older tool outputs without firing any hook. Agent loses content, our state file still says "shown." Recovery requires the agent to call `reset_decision_cache` proactively; if the agent doesn't notice, the gap is unfixable from our side.
- **`/rewind summarize`** has no hook either; same recovery story.
- **Agent self-detection of compaction is unreliable.** Both gaps above depend on it. Belt + suspenders helps but doesn't eliminate.

## Final shape

```
src/storage.ts          155 lines
src/decisions.ts        209 lines
src/mcp.ts              302 lines  (over 250 trigger; growth is the new tools, justified)
src/description.ts       47 lines
src/inject.ts           177 lines
src/session.ts           44 lines
src/cli.ts              130 lines
verify-inject.ts        341 lines
verify-mcp.ts           435 lines
doc/consumption.md      178 lines
```

## Verification

```bash
npx tsc
npm run verify   # all 7 verify scripts green: verify, verify-extract,
                 # verify-resolve, verify-pipeline, verify-decisions,
                 # verify-mcp, verify-inject
```

Manual smoke and full setup in `doc/consumption.md`.
