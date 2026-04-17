# Plan: Decision Capture v2 — Alert Framing + Keyword Vocab

## Context

After the first version of `record_decisions` shipped, agent feedback surfaced four real problems with the write surface:

1. Tool description was thin and misleading. The phrase "ride the call graph" describes a *read-side* behavior that doesn't apply at write time, leaving agents to guess what a "decision" actually meant.
2. `summary` vs `context` had no defined split. Agents either duplicated content or sprawled into both fields with no clear role for either.
3. Decisions had no machine-readable handle for grouping. All knowledge was free prose, so any future read layer would need to do its own keyword extraction.
4. The return string (`recorded N decisions: ids`) gave no signal whether anchors actually pointed at live code. Typos in `file` or `name` were silently accepted, surfacing only on later read.

## Re-anchored design

- **A "decision" is an *alert*, not documentation.** It flags a semantically important situation that grep cannot find — implicit ordering, historical landmines, cross-file coupling, intentional absences, non-obvious distinctions, temporal state. Things grep already finds (PRAGMA settings, type signatures), TODOs, and bug notes are explicitly excluded.
- **Single `decision` field, no `context`.** Progressive disclosure was a premature optimization at this token scale. A typical decision is one terse sentence; splitting it into two fields invited bloat and ambiguity. The alert itself is enough — future AI investigates if relevant.
- **`keywords: string[]` (≥1, agent-provided).** Keywords group decisions semantically and need NOT appear in the decision text — agents use them for business concepts (`billing-flow`) or cross-cutting topics (`retry`). At server startup, the existing keyword set (frequency desc, alphabetical tie-break) is injected into the tool description so the next session sees and reuses them. Self-reinforcing without an internal LLM.
- **Return value reports `anchors live: X/Y`.** Agents self-check typos in one round-trip; `0/2` is a clear signal that both anchors point at code the indexer doesn't know about.

User-confirmed constraints:
- ASCII-only keywords (`^[a-z][a-z0-9-]{0,38}[a-z0-9]$`)
- No per-decision keyword cap; reuse is encouraged via the description, not enforced
- Vocab dump is full when ≤100 distinct keywords, top 100 above that
- No existing `.ctx/graph.db` data to preserve at the time of the rework

## Schema changes (`src/storage.ts`)

```sql
DROP TABLE IF EXISTS decision_nodes;     -- legacy, already present
DROP TABLE IF EXISTS decision_anchors;   -- v2 break
DROP TABLE IF EXISTS decisions;          -- v2 break

CREATE TABLE IF NOT EXISTS decisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  decision   TEXT    NOT NULL,           -- was: summary
  session_id TEXT,                        -- context column removed
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_keywords (
  decision_id INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  keyword     TEXT    NOT NULL,
  PRIMARY KEY (decision_id, keyword)
);

CREATE INDEX IF NOT EXISTS idx_decision_keywords ON decision_keywords(keyword);
```

`decision_anchors` recreated unchanged. No SQL CHECK on keyword format — TS regex is the boundary validator (per CLAUDE.md "Validate only at system boundaries. Trust internal code").

**Implication acknowledged**: the DROPs run on every `openDatabase` call, which means decisions are wiped at every server start. Acceptable while v2 is in flux; revisit before any milestone where decisions need to persist across restarts.

## API (`src/decisions.ts`)

```typescript
export interface Decision {
  id: number
  decision: string
  session_id: string | null
  created_at: string
}

export interface CreateDecisionInput {
  decision: string
  session_id?: string
  anchors:  ReadonlyArray<AnchorInput>
  keywords: ReadonlyArray<string>
}
```

`createDecision`:
- Throws if `keywords.length === 0` (mirrors the existing anchor empty-check).
- Inserts decision row, then anchors, then keywords — all inside the same `db.transaction`.

New helpers:
- `vocabKeywords(db, limit?)` — `SELECT keyword FROM decision_keywords GROUP BY keyword ORDER BY COUNT(*) DESC, keyword ASC [LIMIT ?]`. Frequency derived, not stored.
- `liveAnchorCount(db, decision_ids)` — single query with CASE + EXISTS to count `live`/`total` anchors across a batch. Exported (kept out of `mcp.ts`) because the SQL is non-trivial; inlining bloats the handler.

## Tool surface (`src/mcp.ts` + `src/description.ts`)

Schema (input shape):

```jsonc
{
  decisions: [{
    decision: string,
    keywords: string[]   // minItems: 1
    anchors:  Anchor[]   // minItems: 1, unchanged shape
  }]
}
```

`TOOL_SCHEMA_BASE` holds name + inputSchema. `main()` builds the full tool by combining the base with `buildDescription(db)`, then closes over the result for the `ListToolsRequestSchema` handler. Description is computed once at server startup; vocab updates require restart.

`buildDescription` lives in its own file (`src/description.ts`) — extracted because the description text literal pushed `src/mcp.ts` past the size budget. The function:
- Pulls `vocabKeywords(db)`.
- Emits a description block covering: what a decision is, RECORD-when examples, DO-NOT-record examples, terse-writing instruction, keyword purpose + format, anchor semantics (function vs file, paths).
- Appends `EXISTING KEYWORDS` section when vocab is non-empty, with `top N of total` annotation when truncated.

Validation in `validateDecision` extended with a `validateKeywords` helper that pushes errors for: not-array, empty array, non-string item, format mismatch (`KEYWORD_RE = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/`), duplicate within a single decision. All errors flow through the existing `joinErrors` / `MAX_ERRORS_SHOWN` pipeline — atomicity and accumulation behavior unchanged.

Return value:

```
recorded N decisions (ids: id1, id2, ...); anchors live: X/Y
```

`X/Y` is the count across all anchors of the batch, computed by `liveAnchorCount`.

## Layer responsibilities after this rework

- `storage.ts` — DB lifecycle + schema. No notion of "alert" or "vocab".
- `decisions.ts` — pure SQL operations. No knowledge of MCP or JSON shapes.
- `description.ts` — text composition only. Reads vocab via `decisions.ts`, knows nothing about server lifecycle.
- `mcp.ts` — JSON-Schema, validation, request routing, server lifecycle.

## What this rework deliberately does NOT do

- No internal LLM call (keeps "npm install to use" a hard guarantee).
- No stemming, synonym detection, or vocab merge utility (`redo` and `retry` will fragment unless agents discipline themselves based on the description).
- No read MCP tools (`vocabKeywords`, `liveAnchorCount` are exported for verify use only).
- No multi-language vocab (decision text stays free-form, keywords are ASCII).

## Verify additions

`verify-decisions.ts` — Scenario 12 (vocab frequency + tie-break + limit), Scenario 13 (`liveAnchorCount` across batch including empty batch). Existing scenarios updated for renamed field + required keywords.

`verify-mcp.ts` — Scenarios 14 (keyword required), 15 (empty keywords), 16 (table-driven format violations), 17 (duplicate keyword), 18 (live stats in return), 19 (vocab surfaces in `buildDescription`). Existing scenarios updated for renamed field + new return-string format.

## Final shape

```
src/storage.ts        159 lines  (was 152)
src/decisions.ts      136 lines  (was 100)
src/mcp.ts            224 lines  (was 189)
src/description.ts     47 lines  (new)
verify-decisions.ts   281 lines  (was 211)
verify-mcp.ts         307 lines  (was 205)
doc/mcp.md            182 lines  (was 165)
```
