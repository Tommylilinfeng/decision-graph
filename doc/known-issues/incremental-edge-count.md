# Incremental Re-indexing Must Reset Edge Counts

## Status

**Not yet triggered.** v1 is full-rebuild; the bug this document describes cannot fire until incremental re-indexing ships.

## Summary

`edges.count` accumulates via `ON CONFLICT DO UPDATE SET count = count + 1`. Under full rebuild this is correct: `DELETE FROM nodes` cascades to edges, so every run starts from an empty table and the count matches the number of call sites in the current source.

Under incremental re-indexing, `count` drifts upward across runs unless the pipeline explicitly clears the stale rows first.

## Scenario

Given `src/app.ts`:

```ts
function main() {
  log('start')
  log('middle')
  log('end')
}
```

First index:
- `edges` row: `(main_id, log_id, 'calls', count=3)`

User edits the file, removing two of the three `log` calls:

```ts
function main() {
  log('only one now')
}
```

Correct final state:
- `edges` row: `(main_id, log_id, 'calls', count=1)`

Actual state under naive incremental (re-parse + `insertEdges` for the new calls only):
- Row already exists with `count=3`. One new insert fires the `DO UPDATE`. `count=4`.

The count diverges further on every subsequent edit. There is no SQL statement in the current pipeline that would bring it back down, because nothing deletes the old edges from `main`.

## Why full-rebuild v1 is immune

`indexRepo` runs `db.exec('DELETE FROM nodes')` at the top of the write transaction. `ON DELETE CASCADE` on `edges.source_id` and `edges.target_id` wipes every row. The subsequent `insertEdges` batch starts from an empty table, so `count` always starts at `DEFAULT 1` on the first insert per triplet and accumulates correctly within that single batch.

## What incremental must do

Before re-running `insertEdges` for a changed file `F`, delete every edge rooted at `F`:

```sql
DELETE FROM edges
WHERE source_id IN (SELECT id FROM nodes WHERE file = ?)
```

Then re-upsert the nodes for `F` (identity stable via `(file, name)`, ids preserved), re-resolve the calls, and re-insert the edges. Counts rebuild from zero for that file's outgoing edges.

Inbound edges (other files calling into `F`) do not need to be cleared by this step — their source_ids belong to other files. They are handled by the reverse-dependency re-resolution pass that incremental must also add (separate concern, different document when it exists).

The DELETE must happen **inside** the same transaction as the re-insert. Otherwise a crash between the two leaves the file with no outgoing edges.

## Alternatives considered

### Per-call-site rows, no PK on triplet

One row per observed call, with a `line` or `ordinal` column. Would make counts implicit (`COUNT(*) GROUP BY source, target`). Rejected:

- Table row count grows with call-site count, not relationship count. On a codebase of 10k functions with an average of 20 calls each, this is 200k rows of which ~150k are duplicates.
- "Who calls X" changes from a one-index lookup to an aggregation query.
- The per-site data (line number, surrounding context) has no current consumer. Adding it speculatively violates the project's "high bar for abstraction" rule.

### Nuke-and-rebuild even for incremental

Simplest code path: every `index` run does full rebuild. Kill incremental entirely. Rejected for a different reason — once the project size passes a certain threshold, full rebuild per hook trigger becomes too slow to anchor decisions in real time. The incremental path exists to serve that use case.

### Derive count from a separate per-site table at query time

Keep `edges` as a set (no count), maintain `edge_sites (source_id, target_id, kind, line)` separately. Queryable multiplicity via `COUNT(*)`. Rejected: two tables for what is conceptually one relationship, synchronisation between them becomes a correctness surface.

## When this document becomes obsolete

When incremental lands and its implementation includes the per-file DELETE step above. At that point this document moves from "known issue" to "implementation note in the incremental design doc", and the folder is one issue lighter.
