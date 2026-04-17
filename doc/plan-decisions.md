# Plan: Decision Storage Layer

> **Field schema superseded** by `doc/plan-alert-keywords.md` (single `decision` field replaces `summary`/`context`; new `decision_keywords` table). Anchor model and `decisionsForFunction` semantics described here are still current.

## Context

Storage, extract, resolve, and pipeline layers are complete. This layer adds the project's core differentiator: decision capture anchored to specific functions and files via the existing code graph.

The capture *mechanism* (MCP server, hook, or slash command) is a separate layer documented in `doc/plan-mcp.md`. This plan is the **storage + API** half only.

## Principles from `CLAUDE.md` that shape this plan

- Function-level anchoring is the tool's differentiator over codebase-memory. This plan preserves that and adds file-level as a complement, not a replacement.
- No `try/catch` that swallows errors. Validation throws; callers handle.
- Zero comments by default except for non-obvious invariants (e.g., the empty-string sentinel).
- High bar for abstraction: two anchor kinds ship because each covers cases the other cannot; directory and project kinds are deferred until data proves them.

## Files created or modified

```
src/storage.ts                # schema updated (decisions + decision_anchors tables)
src/decisions.ts              # new file, API + type layer
verify-decisions.ts           # 11 scenarios
doc/storage.md                # Decisions section rewritten
```

No new `src/` subdirectory, no barrel files.

## Schema

Added to `src/storage.ts`'s `SCHEMA` const (runs on every `openDatabase`):

```sql
DROP TABLE IF EXISTS decision_nodes;  -- cleanup from earlier shipped prototype

CREATE TABLE IF NOT EXISTS decisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  summary    TEXT    NOT NULL,
  context    TEXT,
  session_id TEXT,
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_anchors (
  decision_id INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  anchor_kind TEXT    NOT NULL CHECK (anchor_kind IN ('function', 'file')),
  anchor_file TEXT    NOT NULL,
  anchor_name TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (decision_id, anchor_kind, anchor_file, anchor_name),
  CHECK (
    (anchor_kind = 'function' AND anchor_name != '') OR
    (anchor_kind = 'file'     AND anchor_name = '')
  )
);

CREATE INDEX IF NOT EXISTS idx_decision_anchors_lookup
  ON decision_anchors(anchor_file, anchor_name);
```

## Key schema decisions

**Natural-key anchoring (no `node_id` column).** The pipeline runs `DELETE FROM nodes` on every full rebuild. A numeric FK would CASCADE-clear the anchors table every time. Anchoring by `(file, name)` — the same natural key `nodes` uses for `UNIQUE (file, name)` — keeps decisions immune to pipeline churn. `anchorsForDecision` computes live-ness via `EXISTS` at query time.

**Two anchor kinds.** Function-level anchors ride the call graph; file-level anchors cover (a) files with zero functions, (b) decisions semantically about the file not any function in it, (c) future-function inheritance. Neither collapses cleanly into the other. Directory and project kinds are deferred.

**CHECK constraint ties `kind` to `name`.** `anchor_name = ''` is the on-disk sentinel for file-kind; CHECK ensures no row can exist with `kind='function' AND name=''` or `kind='file' AND name='nonempty'`. The sentinel never leaves storage — the API returns discriminated unions.

**No `stale` column.** Computed at query time via `EXISTS` against `nodes`. A persisted column would need trigger machinery for minimal reader benefit.

**Composite index on `(anchor_file, anchor_name)`.** Serves both function-query (full index hit) and file-anchor-query (leading-column hit + residual kind filter). Reverse lookup is the dominant pattern.

## `src/decisions.ts` — layout

```typescript
export interface Decision { id, summary, context|null, session_id|null, created_at }

export type AnchorInput =
  | { kind: 'function'; file: string; name: string }
  | { kind: 'file';     file: string }

export type Anchor =
  | { kind: 'function'; file: string; name: string; live: boolean }
  | { kind: 'file';     file: string;               live: boolean }

export function createDecision(db, {summary, context?, session_id?, anchors}): number
export function decisionsForFunction(db, file, name): Decision[]
export function anchorsForDecision(db, decision_id): Anchor[]
```

**`createDecision`** — single atomic transaction. Empty anchors array throws. Path normalized to POSIX via `.split(path.sep).join('/')`. For file-kind, writes `anchor_name = ''`.

**`decisionsForFunction(file, name)`** — returns the union of function-level anchors matching `(file, name)` and file-level anchors matching `file`, DISTINCT, ORDER BY `created_at DESC`. This is the hook's primary query.

**`anchorsForDecision(id)`** — returns `Anchor[]` as a discriminated union, reconstructed in JS from the stored `anchor_kind` column. `live` computed per-row via `CASE anchor_kind ... EXISTS(...)`.

## What this plan **does not** do

- **No standalone "only-file-anchors" query.** A separate `fileLevelDecisionsFor(file)` has no v1 consumer. `decisionsForFunction(file, someName)` already returns file-level anchors for the file along with function-level ones.
- **No `decisionsForFile(file)` aggregation.** "Every function-level decision for any function in this file" is a C3 graph-aware query.
- **No directory or project anchor kinds.** Multi-file "directory-ish" patterns are expressed by listing files. Project-level rules live in `CLAUDE.md` / `README.md`.
- **No decision relationships** (`caused_by`, `supersedes`, `conflicts_with`).
- **No content-based deduplication.** Two identical summaries produce two rows.
- **No MCP, no hook, no CLI** — those are separate layers.

## `verify-decisions.ts` — 11 scenarios

Each self-contained where feasible, `/tmp/ctx-verify-decisions.db`.

1. Create + single function anchor + reverse lookup
2. Multi-anchor fan-out with mixed kinds (function × 2 + file × 1)
3. Empty anchors array throws
4. CASCADE on decision delete
5. Node churn survival — `db.transaction(() => db.exec('DELETE FROM nodes'))()` then query still returns the decision; `live` flips false; after re-upsert, `live` flips true
6. Dead function anchor query still returns the decision
7. Path normalization for both kinds (backslash input → POSIX on the stored row)
8. File-kind anchor reachable via `decisionsForFunction` (the **bubble-up** proof)
9. Aggregation: `decisionsForFunction` returns both function-level and file-level decisions on the same file
10. File-kind live semantics: `live` depends on "any node in this file exists", not "specific function"
11. CHECK constraint enforces kind↔name invariant (raw SQL inserts that violate throw)

## Implementation order

1. Edit `src/storage.ts` SCHEMA const
2. Write `src/decisions.ts` (types + 3 exported functions + `toPosix` helper)
3. Write `verify-decisions.ts` with 11 scenarios
4. `npx tsc` — clean
5. `rm -rf /tmp/ctx-verify-decisions.db* ./.ctx` then run all five verify scripts
6. Update `doc/storage.md` Decisions section
7. `wc -l` size check

## Failure signals

- `src/decisions.ts` exceeds 120 lines: refactor
- Any validation/write function exceeds 20 lines: refactor
- Any scenario fails: fix the code, never the assertion
- CHECK constraint scenario (11) doesn't throw: the CHECK clause regressed — fix the schema

## Verification

```bash
rm -f /tmp/ctx-verify-decisions.db /tmp/ctx-verify-decisions.db-wal /tmp/ctx-verify-decisions.db-shm
rm -rf ./.ctx
npx tsc
node dist/verify.js
node dist/verify-extract.js
node dist/verify-resolve.js
node dist/verify-pipeline.js
node dist/verify-decisions.js     # 11 scenarios, prints "OK"
wc -l src/decisions.ts src/storage.ts verify-decisions.ts
```

Budget: `src/decisions.ts` ≤ 120, `src/storage.ts` ≤ 155, `verify-decisions.ts` ≤ 180.

## Notes from implementation

- Ended at `src/decisions.ts` = 100 lines, `src/storage.ts` = 151 lines, `verify-decisions.ts` = 211 lines.
- `verify-decisions.ts` overshot by 31 lines because each scenario was kept self-contained (own upserts, own decisions, own assertions) rather than sharing setup. The tradeoff of "readable as a scenario list" over "compact in lines" was kept — verify is executable documentation.
- `DROP TABLE IF EXISTS decision_nodes` in SCHEMA cleaned up the earlier prototype that shipped `decision_nodes` (natural-key, no kind column) in the same session. No migration needed — the prototype was never outside the dogfood run.
- The empty-string sentinel (`anchor_name = ''` for file-kind) was originally a concern as "SQLite detail leaking out". The discriminated-union API return type keeps it contained — callers pattern-match on `kind`, never inspect `name` on file-kind anchors.
- `EXISTS`-based live computation runs O(decision_anchor_count) subqueries for `anchorsForDecision`. Not a concern at the scales of v1, but flagged here for future.
