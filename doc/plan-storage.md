# Plan: Storage Layer

## Context

Working directory is empty except `CLAUDE.md` (working principles) and `doc/storage.md` (storage layer spec). Implementing the storage layer exactly as specified in `doc/storage.md`. Nothing else.

Scope: two SQLite tables (`nodes`, `edges`), eight exported functions, no parser, no pipeline, no MCP. When this layer is done and verified, we move on to extraction.

Principles from `CLAUDE.md` that shape this plan:
- Single file for the whole layer unless it exceeds 200 lines. No barrel re-exports.
- Functions over handle, no class (no module-level state).
- No `try/catch` that swallows errors; exceptions bubble.

Project-root convention (`<root>/.ctx/graph.db` with the root derived by walking up from the DB file) is already locked in `doc/storage.md` under "Database location". Not restated here.

## Files to create

```
package.json                   # better-sqlite3 + typescript, nothing else
tsconfig.json                  # strict, ES2022, CommonJS, dist/
.gitignore                     # node_modules, dist, .ctx
src/storage.ts                 # the whole storage layer (~150 lines)
verify.ts                      # smoke test script (runs the API end-to-end)
```

No `src/index.ts`, no `src/storage/` subdirectory, no barrel files.

## `src/storage.ts` — single-file API

Layout in this order:
1. Imports (`better-sqlite3` only)
2. Types: `NodeKind`, `EdgeKind`, `NodeInput`, `Node`, `EdgeInput`, `Edge`
3. Schema DDL as a const string
4. `openDatabase(path)` — create handle, apply pragmas, run DDL (`CREATE TABLE IF NOT EXISTS`)
5. `closeDatabase(db)`
6. `upsertNodes(db, nodes[]) → number[]` — batch upsert. SQL per row:
   ```sql
   INSERT INTO nodes (file, name, kind, start_line, end_line)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT (file, name) DO UPDATE SET
     start_line = excluded.start_line,
     end_line   = excluded.end_line
   RETURNING id
   ```
   Loop the prepared statement over `nodes`, collect `id` from each `stmt.get(...)`, wrap the loop in one `db.transaction(...)()`. Contract: **the returned `number[]` is in the same order as the input `nodes[]`** (callers rely on positional matching when they built edges referencing indices).
7. `insertEdges(db, edges[])` — batch insert with `INSERT OR IGNORE`, transactional.
8. `findNodeById(db, id)` — returns `Node | undefined`.
9. `findNodesByName(db, name)` — returns `Node[]`.
10. `findNodesByFile(db, file)` — returns `Node[]`.
11. `findNodeAtLine(db, file, line)` — full SQL:
    ```sql
    SELECT * FROM nodes
    WHERE file = ? AND start_line <= ? AND end_line >= ?
    ORDER BY (end_line - start_line) ASC
    LIMIT 1
    ```
    `ORDER BY` picks the innermost match (shortest range) when nested functions exist. In v1 there is no nesting, but the clause costs nothing and is verified.
12. `edgesFromNode(db, source_id)` — returns `Edge[]`.
13. `edgesToNode(db, target_id)` — returns `Edge[]`.

SQL is prepared once per function call and reused across the batch loop inside that call. No statement caching across calls (better-sqlite3 does not cache).

## `verify.ts` — smoke test

Creates `/tmp/ctx-verify.db`, exercises every exported function, asserts invariants, prints `OK` or throws. Deletes the file on clean exit.

Scenarios:
1. Open, upsert 3 nodes, confirm ids returned in input order, confirm `findNodesByName` returns them.
2. **Identity-stability under cosmetic edit (the core guarantee).** Using the 3 nodes from scenario 1, insert 2 edges between them. Re-upsert the same 3 nodes with shifted `start_line` / `end_line` values (as if a blank line were added at the top of the file). Assert (a) ids unchanged, (b) line numbers updated, (c) both edges still present via `edgesFromNode` / `edgesToNode`. This is the scenario that would have failed under the old `(file, start_line, name)` identity scheme.
3. Insert a duplicate edge — confirm no error and no duplicate row (INSERT OR IGNORE).
4. **`findNodeAtLine` flat.** One node, lines 10–20. Query line 15, confirm it is returned.
5. **`findNodeAtLine` nested (verifies the `ORDER BY`).** Two nodes in the same file with different names: `outer` at lines 10–50, `inner` at lines 20–30. Query line 25 — must return `inner`. Query line 15 — must return `outer`. If this assertion ever fails, the `ORDER BY (end_line - start_line) ASC` clause has regressed.
6. Delete one node via raw SQL — confirm `edgesFromNode(source_id)` and `edgesToNode(target_id)` for edges touching that node return empty (cascade delete worked).
7. Close.

Runs as `node dist/verify.js`.

## Dependencies

```json
"dependencies": {
  "better-sqlite3": "^11.0.0"
},
"devDependencies": {
  "@types/better-sqlite3": "^7.6.0",
  "typescript": "^5.4.0",
  "@types/node": "^20.0.0"
}
```

No `glob`, no `tree-sitter`, no `zod`. Those belong to later layers.

## `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*", "verify.ts"],
  "exclude": ["node_modules", "dist"]
}
```

`rootDir: "."` so both `src/storage.ts` and the top-level `verify.ts` compile. No `declaration` — this is not a published package.

## `.gitignore`

```
node_modules/
dist/
.ctx/
*.db
*.db-wal
*.db-shm
.DS_Store
```

## Implementation order

1. Scaffold: `package.json`, `tsconfig.json`, `.gitignore`. Run `npm install`.
2. Write `src/storage.ts`. `npx tsc --noEmit` must be clean.
3. Write `verify.ts`. `npx tsc` then `node dist/verify.js`. Must print `OK`.
4. If it prints OK and `tsc` is clean, storage layer is done.

## What would make this a failure

- `src/storage.ts` exceeds 200 lines: pull something out into a separate file.
- Any function exceeds 20 lines: refactor.
- TypeScript produces even one strict-mode error: fix.
- `verify.ts` throws: fix the bug.
- Any `try/catch` in `src/storage.ts` that swallows the error instead of rethrowing with added context: remove.
- Any `console.log` left in `src/storage.ts`: remove.

## What I am deliberately not doing

- No migration / version column.
- No `decisions` or `decision_nodes` table — that layer arrives with hooks.
- No FTS5, no fuzzy search.
- No `kind` filter on edge queries.
- No separate `insertNodes` (non-upsert) API.
- No class wrapping the handle.
- No CLI.
- No formal test framework (Jest, Vitest). `verify.ts` is sufficient until we have more to test.
- No exports of types from `src/index.ts` — there is no `src/index.ts`.

## Verification

```bash
npm install
npx tsc            # clean compile
node dist/verify.js
# expected: "OK" on stdout, exit code 0
```

Then `wc -l src/storage.ts` — expect under 200.
