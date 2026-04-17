# Storage Layer

## What it does

Persist the code graph on disk. Two things:

- **Nodes**: functions in the source code, each anchored to a file and name.
- **Edges**: directed relationships between nodes, starting with function calls.

## What it does not do

- Parse source code (`extract/` does that later).
- Resolve names to ids (`pipeline/` does that later).
- Re-index incrementally (not built yet).
- Rank search results (not built yet).
- Expose the data over MCP (not built yet).

The storage layer knows about SQL. Nothing else.

## Database location

Every database lives at:

```
<project-root>/.ctx/graph.db
```

Soft convention: `openDatabase` accepts any path, but consumers that care about paths (hooks, MCP) derive the project root by walking up from the database file to `.ctx/`'s parent. If you break the convention, you break the derivation. The library does not enforce it today.

## Schema

```sql
CREATE TABLE nodes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file       TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('function')),
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  UNIQUE (file, name)
);

CREATE TABLE edges (
  source_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind      TEXT    NOT NULL CHECK (kind IN ('calls')),
  count     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (source_id, target_id, kind)
);

CREATE INDEX idx_nodes_name   ON nodes(name);
CREATE INDEX idx_nodes_file   ON nodes(file);
CREATE INDEX idx_edges_source ON edges(source_id, kind);
CREATE INDEX idx_edges_target ON edges(target_id, kind);
```

Two tables. Six node columns. Four edge columns. Four indexes. Every line is justified below.

Two pragmas run on open:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
```

## Design decisions

### Identity is `(file, name)`, not `(file, start_line, name)`

A user puts their cursor at line 1 and hits Enter. Every function in the file shifts down by one. If `start_line` is part of the node's identity, the old nodes do not match the new nodes. The upsert logic sees them all as deleted and re-inserted, and `ON DELETE CASCADE` wipes every inbound edge. One blank line = the file's entire call graph dies.

Identity has to be stable across cosmetic edits. `(file, name)` is stable; `start_line` is not.

`start_line` and `end_line` remain as mutable columns, updated in place when the function moves. Edges survive because the node's `id` does not change.

Collisions (two top-level functions with the same name in one file) are syntax errors in strict TypeScript. Extract deduplicates in advance — keeping the first occurrence and reporting the rest via `duplicateFunctionNames` — so `UNIQUE (file, name)` never fires in practice. The lossy side of that dedup is documented in `doc/known-issues/same-file-duplicate-names.md`; `UNIQUE` exists as a belt-and-braces catch for a dedup bug.

When we add methods and nested classes, identity extends to `(file, parent, name)` — a `parent` column, not extra line columns.

### No `project` column

One database file is one project. Multiple projects means multiple database files. A `project` column would add one byte to every row and one `WHERE` clause to every query in exchange for a feature nobody has asked for.

### No `qualified_name`

A computed string like `project.src.models.order.createOrder` (codebase-memory uses this) has two problems:
- `foo/index.ts` and `foo.ts` both collapse to the same string and collide on `UNIQUE`.
- Deciding how to build the string (strip extensions? strip `index`? join with `.`?) is an opinion the schema should not carry.

We already store `(file, name)`. Any caller that needs a display string composes its own.

### `file` is a relative text path

Not an absolute path: absolute paths break when the repo moves.
Not a separate `files` table: that table would have one column today (the path). Add the table when there is a second column worth storing.

Paths are relative to the project root. The root is `.ctx/`'s parent directory.

### `kind TEXT CHECK(...)`

Alternatives rejected:
- Plain `TEXT`: typos fail silently. Silent failures are bugs.
- Lookup table: overkill for short enums.
- SQLite has no `ENUM`.

`CHECK` fails loud at insert time. Adding a kind is a one-line edit to the clause.

### `kind IN ('function')` today

Methods, classes, and interfaces are not in v1. A decision hook in v1 attaches to a function edit, which is a function. When we need to anchor a decision to a class or interface, we add the value to the `CHECK` clause.

Same reasoning for edges: only `calls` today. `imports` and `contains` arrive when there is a query that needs them.

### Edges have no `id` column

`(source_id, target_id, kind)` is a natural composite key. An auto-increment id on top of it would be dead weight.

### No `confidence` column

An earlier design borrowed a 4-strategy call resolver from `codebase-memory` where each strategy carried a score. We later collapsed to priority-ordered strategies 1+2 (import match, same-module) and dropped scoring entirely — see `doc/plan-resolve.md`. Storing a score as an edge column would have frozen an unvalidated choice into the schema. If we later need a queryable score, we add the column then.

### No `properties JSON` column

A JSON blob is where schema decisions go to hide. Every field inside it is a field we chose not to think about. When we need a queryable attribute (like `is_exported`), we add a real column.

### Four indexes, no more

The queries we run:
- "What function was just edited?" → `idx_nodes_name` plus `idx_nodes_file` for the file filter.
- "What function contains this line?" → covered by `idx_nodes_file`.
- "What does X call?" → `idx_edges_source`.
- "What calls X?" → `idx_edges_target`.

Every additional index slows inserts. We add more when a query needs them.

### `ON DELETE CASCADE` on edges

Deleting a node without deleting its edges leaves dangling references. Cascade is the standard SQL idiom.

With identity based on `(file, name)`, cosmetic edits do not trigger deletes — line numbers update in place. A cascade only fires when a function is actually renamed or removed, which is a semantic change. At that point, reverse-dependency re-resolution (find all files whose edges pointed at the deleted node, re-process them) is narrow and matches the cost of the change. That logic lives in the pipeline when we add incremental.

### `journal_mode = WAL`

The indexer writes in one process; hooks and MCP read in another. Default journal mode blocks readers during writes. WAL allows concurrent reads while the index is rebuilding. WAL creates two sibling files next to the database (`-wal`, `-shm`).

### `foreign_keys = ON`

SQLite does not enforce foreign keys by default. `ON DELETE CASCADE` needs them on.

### No schema version column

Three futures:
1. We never change the schema. The column was noise.
2. We add columns or tables (backward compatible). Old databases remain valid.
3. We break the schema. Users delete and re-index. The column would not save anyone.

When we hit future 3 twice in a row, we add versioning. Not before.

## Public API

Pure functions over a handle. The handle is the SQLite connection returned by `openDatabase`.

```typescript
openDatabase(path: string): Database
closeDatabase(db: Database): void

upsertNodes(db: Database, nodes: NodeInput[]): number[]
insertEdges(db: Database, edges: EdgeInput[]): void

findNodeById(db: Database, id: number): Node | undefined
findNodesByName(db: Database, name: string): Node[]
findNodesByFile(db: Database, file: string): Node[]
findNodeAtLine(db: Database, file: string, line: number): Node | undefined

edgesFromNode(db: Database, source_id: number): Edge[]
edgesToNode(db: Database, target_id: number): Edge[]
```

Types:

```typescript
type NodeKind = 'function'
type EdgeKind = 'calls'

interface NodeInput {
  file: string
  name: string
  kind: NodeKind
  start_line: number
  end_line: number
}

interface Node extends NodeInput {
  id: number
}

interface EdgeInput {
  source_id: number
  target_id: number
  kind: EdgeKind
}

interface Edge extends EdgeInput {
  count: number
}
```

### Why `upsertNodes` instead of `insertNodes`

A v1 full rebuild deletes the database and inserts from scratch — no conflicts. A v2 incremental rebuild will re-run extraction on a changed file and needs to update existing rows. `upsertNodes` handles both with one API:

```sql
INSERT INTO nodes (...) VALUES (...)
ON CONFLICT (file, name) DO UPDATE SET
  start_line = excluded.start_line,
  end_line   = excluded.end_line
```

The node's `id` is preserved. Edges that reference it survive the update. This is the whole point of the identity change above.

### Why `findNodeAtLine`

The decision hook's first query is "I just edited `src/foo.ts` line 42, what function is that?" Without this helper, every consumer writes the same `findNodesByFile` + filter dance. Implementation:

```sql
SELECT * FROM nodes
WHERE file = ? AND start_line <= ? AND end_line >= ?
ORDER BY (end_line - start_line) ASC
LIMIT 1
```

The `ORDER BY` handles future nested functions (innermost wins). In v1 there is no nesting, but the clause costs nothing.

### Why `insertEdges` increments `count` on conflict

Edges have one mutable attribute: `count`, the number of distinct call sites in the source that refer to the target. When `insertEdges` hits a duplicate `(source_id, target_id, kind)` triplet, the SQL is:

```sql
INSERT INTO edges (source_id, target_id, kind) VALUES (?, ?, ?)
ON CONFLICT (source_id, target_id, kind) DO UPDATE SET count = count + 1
```

The earlier `INSERT OR IGNORE` design folded duplicates silently. Dogfood on this project produced 117 resolved calls collapsing into 53 edges — 64 call-site instances lost to deduplication. `count` recovers that multiplicity without giving up the triplet primary key (which is what makes "who calls X" a single-index lookup).

The API still exposes `insertEdges`, not `upsertEdges`. The name reflects the caller's action (inserting one row per observed call site); `count` is a storage-layer detail that accumulates underneath. Callers of `edgesFromNode` / `edgesToNode` receive the count column in each `Edge` row and can ignore it when they only need relationship existence.

One caveat, documented separately: under incremental re-indexing, raw `count + 1` over-accumulates when a re-indexed source file has fewer call sites than before. v1 is full-rebuild (every run starts from `DELETE FROM nodes`, which CASCADE-clears edges), so the issue does not fire today. See `doc/known-issues/incremental-edge-count.md` for the protocol that incremental must implement.

### Why batch-only

The pipeline produces thousands of nodes at once. A single-node API would only be used in tests, and tests can pass a one-element array.

### Why `edgesFromNode` takes no `kind` filter

One edge kind today. When we add a second, we add the parameter in the same commit that adds the kind.

### Why `findNodeById` exists

The query layer follows edges from source to target. It has a `target_id` and needs the node. Forcing callers to write raw SQL is worse.

### Why it is functions, not a class

No storage-level state outside the connection. A class would only be a namespace. Functions on a handle read more directly.

## Error behavior

- `upsertNodes` on a `CHECK` violation (unknown `kind`): throws.
- `upsertNodes` on a valid row: inserts or updates. Never throws for a normal operation.
- `insertEdges` on duplicates: increments the existing row's `count` by 1; no new row inserted.
- `insertEdges` on a dangling `source_id` or `target_id`: throws (FK violation).
- `findNode*` with no matches: returns `undefined` or `[]`. Not an error.
- `openDatabase` on a missing file: creates it with the schema.
- `openDatabase` on an unreadable file: throws from `better-sqlite3`.

No `try/catch` inside this layer. Exceptions bubble.

## Decisions

> **This section is partially superseded.** Field schema reworked in `doc/plan-alert-keywords.md`: `summary` → `decision`, `context` removed, new `decision_keywords` table added. The "No `decisionsForFile(file)` aggregation" claim under "Out of scope" was reversed in `doc/plan-consumption.md` (the consumption layer needs it). Anchor model + storage location reasoning below remain accurate.

Decision capture is the project's differentiator versus plain code graphs. Storage is in place; the capture mechanism (Claude Code hook, MCP server, or slash command) is separate and not in this layer.

### Schema

```sql
CREATE TABLE decisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  summary    TEXT    NOT NULL,
  context    TEXT,
  session_id TEXT,
  created_at TEXT    NOT NULL
);

CREATE TABLE decision_anchors (
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

CREATE INDEX idx_decision_anchors_lookup ON decision_anchors(anchor_file, anchor_name);
```

Five fields on `decisions`. Four on `decision_anchors`, plus a CHECK invariant that ties `anchor_kind` to `anchor_name`. One index. Every line justified below.

### Why two anchor kinds (function and file)

Function-level anchoring is the tool's primary differentiator over codebase-memory and other file-level-only knowledge stores. A function anchor rides the call graph: once anchored, a decision on `foo` participates in every graph-traversal query (callers, callees, reachable-from). File-level-only systems cannot answer "decisions on functions my edit reaches" because files do not call files.

File-level anchors are not a downgrade — they cover three cases a pure function-level model cannot:

1. **Files without functions.** A `types.ts` with only interface declarations produces zero `function` nodes. A decision about that file has nowhere to anchor in a function-only model.
2. **Decisions about file identity.** "`src/store/user.ts` is the single source of truth for user state" is a claim about the file, not any function inside it. Spreading such a decision across every function in the file distorts its meaning.
3. **Future-function inheritance.** A file-level decision automatically applies to functions added later. Function-level anchors would miss them until the decision is manually re-attached.

Both kinds live in the same junction table (`decision_anchors`) with an explicit `anchor_kind` column. The CHECK constraint enforces that a function row has a non-empty `anchor_name` and a file row has `anchor_name = ''`. The empty string is the on-disk sentinel for "no function component"; callers never see it because the API returns a discriminated union.

### Why natural-key anchoring, not `node_id`

The pipeline runs `DELETE FROM nodes` on every full rebuild (`doc/plan-pipeline.md` decision 1). Any column referencing `nodes(id)` would CASCADE-clear, wiping every decision's anchors on every re-index. Decisions would not survive a single `index` run.

`decision_anchors` keys by `(anchor_file, anchor_name)` — the same natural key `nodes` already uses for `UNIQUE (file, name)`. Pipeline churn on node ids is invisible to decisions. The alternative — changing the pipeline to upsert-preserving — is half of incremental re-indexing; this shortcut avoids that entanglement entirely. See `doc/known-issues/incremental-edge-count.md` for a related discussion of why touching pipeline semantics has wider implications.

### Why no `stale` column

The status "this decision's anchor no longer exists" is computed at query time via an `EXISTS` subquery against `nodes`. Persisting a `stale` column would require trigger-or-hook machinery to keep it in sync with the nodes table, and v1 has no reader for a persistent staleness flag. The inline EXISTS is cheap enough at this table size.

If later we need a user-settable "this decision is archived, stop showing it" flag, that is a different concept and gets a differently-named column (`archived`, maybe) added when data demands it.

### Why the reverse-lookup index

The primary key `(decision_id, anchor_kind, anchor_file, anchor_name)` covers the forward query ("what anchors does decision D have?") but not the reverse ("what decisions anchor at this function, or at this file?"). The reverse is the dominant query pattern — every time Claude edits a file, the hook-side will ask "are there decisions on this function?" and the answer combines function-level and file-level anchors on that file.

The index `(anchor_file, anchor_name)` serves both:
- Function-level queries filter by `anchor_file = ? AND anchor_name = ?` — a full index hit.
- File-level queries filter by `anchor_file = ? AND anchor_kind = 'file'` — leading-column hit plus residual kind filter.

### What is *not* in v1

- **No standalone "only-file-anchors" retrieval.** `decisionsForFunction(file, name)` already returns file-level decisions for the file along with function-level ones on `(file, name)`. A separate `fileLevelDecisionsFor(file)` has no v1 consumer — any use case that needs it is covered by the function-level aggregation. The name is reclaimable later if a real use appears (e.g., an admin tool listing all file-scoped commitments).
- **No `decisionsForFile(file)` aggregation.** A query that returns "every function-level decision for any function in this file, plus the file-level ones" is a C3 graph-aware query shape. The dominant v1 query is "editing a specific function" — that's what `decisionsForFunction` serves.
- **No directory anchor kind.** Patterns like "all files in `src/auth/`" are expressed by listing the files as separate anchors. Directory anchors add prefix-matching complexity and are speculative until real decisions accumulate enough file-anchor fan-out to justify the glob step.
- **No project anchor kind.** Architecture-level rules ("we don't use Redux") live in `CLAUDE.md` or `README.md` until data shows queryable project scope is needed. Decisions must anchor to at least one function or file.
- **No decision relationships** (`caused_by`, `supersedes`, `conflicts_with`). Decisions accumulate as a flat set. See `CLAUDE.md` for the explicit out-of-scope list.
- **No content-based deduplication.** Two decisions with identical summaries create two rows. Idempotence is a caller concern.

### Public API

Lives in `src/decisions.ts`, not `src/storage.ts` — different domain (knowledge anchoring vs graph persistence), and the split keeps both files under their size budgets.

```typescript
interface Decision {
  id: number
  summary: string
  context: string | null
  session_id: string | null
  created_at: string
}

type AnchorInput =
  | { kind: 'function'; file: string; name: string }
  | { kind: 'file';     file: string }

type Anchor =
  | { kind: 'function'; file: string; name: string; live: boolean }
  | { kind: 'file';     file: string;               live: boolean }

createDecision(db, {
  summary: string,
  context?: string,
  session_id?: string,
  anchors: ReadonlyArray<AnchorInput>,  // non-empty; throws otherwise
}): number
// Atomic: inserts decision + all anchor rows in one transaction.
// Normalizes path separators to POSIX before insert.

decisionsForFunction(db, file: string, name: string): Decision[]
// Returns the union of:
//   - function-level anchors matching (file, name)
//   - file-level anchors matching the file
// DISTINCT, ORDER BY created_at DESC.

anchorsForDecision(db, decision_id): Anchor[]
// Discriminated union based on anchor_kind. `live` semantics:
//   function → EXISTS node with (file, name)
//   file     → EXISTS any node with this file
```

Discriminated union on `AnchorInput` and `Anchor` means callers write `if (a.kind === 'function') a.name` — the empty-string sentinel for file-kind never leaves the storage layer.

### Why `createDecision` is atomic, not `createDecision` + `linkAnchor`

Separating creation from linking was the earlier design. It meant callers had to remember to call both, and forgetting the second produced an orphan decision that could never be found by any query (no `decision_anchors` row to join through). The invariant "a decision has ≥1 anchor" only matters if the API enforces it. A two-call design pushes enforcement onto every caller and every future hook implementer.

One call, required non-empty array, everything in one transaction. The "pre-existing decision, add another anchor later" use case does not exist in v1 and can be carved out if real use appears twice (CLAUDE.md's abstraction threshold).

## Known limitations

- **Single writer.** Insert functions are not safe to call from multiple processes at once. The indexer is one-shot.
- **No incremental re-indexing in v1.** Every `index` run rebuilds from scratch. For repos under ~10k files this is seconds.
- **Reverse-dependency re-resolution not implemented.** When incremental lands, deleting a function requires re-processing files that referenced it. Not written yet.
- **v1 stores only functions.** Classes, methods, and interfaces are not in the schema.
- **Root derivation depends on convention.** `openDatabase` accepts any path. If the database is not at `<root>/.ctx/graph.db`, consumers that derive the root will get the wrong directory.

## When the schema changes

- **Add a column**: edit schema, delete database, re-index.
- **Add a kind value**: edit the `CHECK`, delete database, re-index.
- **Add incremental**: new `file_hashes` table, new functions on it, reverse-dep re-resolution in the pipeline. Updates this document.
- **Add decisions**: new `decisions` and `decision_nodes` tables per the shape above. Does not change existing tables.
