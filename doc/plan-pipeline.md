# Plan: Pipeline Layer + CLI

## Context

Storage, extract, and resolve layers are each implemented, verified, and documented. They are three disconnected primitives until something calls them in the right order. This layer is that something.

Pipeline glues the three layers by the fixed 13-step flow described below. CLI is a thin argument parser over it. Together they produce a populated SQLite database at `<root>/.ctx/graph.db` from a repo directory.

## Decisions locked in

1. **Full rebuild per run.** `DELETE FROM nodes` inside a single transaction, then re-insert. Edges cascade-clear. Simple, idempotent, no orphan logic. The `UNIQUE(file, name)` identity scheme in storage was designed for incremental but pipeline does not use it — incremental ships with `file_hashes` in a later version. The identity guarantee is proven by `verify.ts` scenario 2, not by pipeline.
2. **Hardcoded exclusion list.** No `--include` / `--exclude` flags:
   ```
   node_modules/**, dist/**, build/**, out/**, .git/**, .ctx/**
   .next/**, .turbo/**, .vercel/**, .cache/**, coverage/**
   __tests__/**
   *.test.ts, *.test.tsx, *.test.js, *.spec.ts, *.spec.js
   *.config.ts, *.config.tsx, *.config.js, *.config.mjs, *.config.cjs
   *.d.ts, *.min.js, *.bundle.js
   ```
   Test files are skipped. Not "tests don't matter" — "we don't know yet what MCP wants from them, and adding later is easier than removing." Documented.
3. **Single-file exceptions are caught + skipped + counted.** The summary shows the count and the first three filenames (the `3` is a display choice carried from the earlier discussion; no other constants are hardcoded). Note: `extract.ts` already tolerates syntax errors (returns empty results), so this `try/catch` mainly catches rare runtime errors (fs failures, WASM crashes). Belt and suspenders.
4. **No progress stream.** Silent while running, single summary block at end. If someone later complains "it looks frozen", the cheap upgrade is one `.` per file; we are not there.
5. **No concurrency.** Single-threaded. `better-sqlite3` is sync; `extract` is CPU-bound but adding worker threads means per-worker WASM load + AST serialization — complexity burns more than it saves on sub-minute index runs.
6. **DB location fixed at `<root>/.ctx/graph.db`.** CLI does `fs.mkdirSync(root/.ctx, { recursive: true })` before opening. Matches `doc/storage.md` convention.
7. **CLI surface is two commands.** `index <path>` and `stats [--path <path>]`. No `init`, no `watch`, no `clean`, no `search`. MCP and everything else lives elsewhere later.
8. **File discovery inlined into pipeline.ts.** No `src/discover.ts` — a glob call with an ignore list is small enough to sit alongside `indexRepo`. Separating it would be ceremony.
9. **POSIX path normalization at every boundary.** `glob` output, `path.relative` output, registry keys, storage `file` column — all `/`. One-line `.split(path.sep).join('/')` wherever a native-separator path enters our layer.
10. **Symlinks are not followed.** `glob` with `follow: false`. Prevents symlink loops without extra code.

## Files

```
src/pipeline.ts      # orchestrator + file discovery + language detection — target <200 lines
src/cli.ts           # CLI entry, handles 'index' and 'stats' — target <80 lines
verify-pipeline.ts   # 7 scenarios on /tmp fixture repos
```

## `src/pipeline.ts` — shape

```typescript
export interface PipelineResult {
  files: number
  functions: number
  calls: number
  resolved: number
  unresolved: number
  parseFailures: Array<{ file: string; error: string }>
  durationMs: number
}

export async function indexRepo(rootDir: string): Promise<PipelineResult>
```

### The fixed 13 steps

```
 1. absRoot = path.resolve(rootDir)
 2. fs.mkdirSync(absRoot/.ctx, { recursive: true })
 3. db = openDatabase(absRoot/.ctx/graph.db)
 4. await initParser()
 5. files = discoverFiles(absRoot)            # glob + normalize to POSIX
 6. For each file:                             # PARSE PHASE (outside txn)
      read source
      extract(source, lang) → collect per-file { functions, imports }
      on exception: push to parseFailures, continue
 7. For each file:                             # RESOLVE-IMPORTS PHASE (outside txn)
      for each import:
        resolveImport(specifier, file, absRoot)
      build ResolverImport[] with resolved_file attached
 8. db.transaction(() => {                     # WRITE PHASE
 9.   db.exec('DELETE FROM nodes')             # cascades to edges
10.   flatten all parsed functions into NodeInput[]
      ids = upsertNodes(db, nodeInputs)        # order-preserving
      registry = buildRegistry(nodeInputs + ids)
11.   for each function: for each call:
        targetId = resolveCall(callee, file, imports, registry)
        if targetId: edges.push({ source_id, target_id, kind: 'calls' })
      collect stats: callCount, resolvedCount
12.   insertEdges(db, edges)
13. })()  # commit
    closeDatabase(db)
    return PipelineResult
```

Key ordering constraint: parsing must finish for **all** files before any `resolveCall` runs. Strategy 1 (`import_map`) needs the target file's functions to exist in the registry, and the registry cannot be built before `upsertNodes` has run for every file's functions. No interleaving.

### `discoverFiles(absRoot): string[]`

```typescript
const IGNORE = [
  '**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**',
  '**/.git/**', '**/.ctx/**', '**/__tests__/**',
  '**/.next/**', '**/.turbo/**', '**/.vercel/**', '**/.cache/**',
  '**/coverage/**',
  '**/*.test.ts', '**/*.test.tsx', '**/*.test.js',
  '**/*.spec.ts', '**/*.spec.js',
  '**/*.config.ts', '**/*.config.tsx',
  '**/*.config.js', '**/*.config.mjs', '**/*.config.cjs',
  '**/*.d.ts', '**/*.min.js', '**/*.bundle.js',
]
const PATTERN = '**/*.{ts,tsx,js,jsx,mjs,cjs}'

function discoverFiles(absRoot: string): string[] {
  const paths = globSync(PATTERN, {
    cwd: absRoot,
    ignore: IGNORE,
    nodir: true,
    follow: false,
  })
  return paths.map(p => p.split(path.sep).join('/')).sort()
}
```

### `languageFromFile(file: string): Language | null`

Inline helper, ~6 lines, maps extension → `'typescript' | 'tsx' | 'javascript'` or returns `null` for files that slipped through.

## `src/cli.ts` — shape

```
$ context-chain index <path>
$ context-chain stats [--path <path>]
```

### `index <path>`

1. Call `indexRepo(path)`.
2. Print summary in this format:
   ```
   Indexed 11 files in 0.0s
     51 functions
     345 calls → 96 resolved (28%), 249 unresolved
     2 parse failures: src/legacy.ts, src/gen/schema.ts
   ```
   Numbers above are from a real dogfood run on this project — not a target. A typical TS repo sits around 25–35% resolved because explicitly does not resolve member chains, default imports, namespace imports, or external calls. See "Failure signals" below. Last line only shown if `parseFailures.length > 0`. First three filenames, comma-joined. If calls total is 0, skip the percentage to avoid divide-by-zero.

### `stats [--path <path>]`

1. Resolve `<path>` (default `.`), derive `<root>/.ctx/graph.db`.
2. If the resolved DB path does not exist: write `no index found at <path> — run 'context-chain index' first` to **stderr** and exit 1.
3. Open DB.
4. Print to **stdout**:
   ```
   N nodes, M edges
   ```
5. Close DB.

### Unknown / missing command

Write the two-line usage text to **stderr**, exit 1.

### stdout / stderr discipline

- `stdout`: summary of a successful run (`index`), or query output (`stats`). Nothing else.
- `stderr`: all error messages (usage errors, missing-index error, unexpected exceptions).
- Exit code: `0` on success, `1` on any handled error.

## `verify-pipeline.ts` — 7 scenarios

All use `/tmp/ctx-pipeline-test-<n>/` fixture trees, torn down on clean exit.

1. **Happy path end-to-end.** Fixture:
   - `src/a.ts`: `export function formatName(s) { return s }`
   - `src/b.ts`: `import { formatName } from './a'; export function main() { formatName('x') }`

   After `indexRepo`: 2 files, 2 functions, 1 call, 1 resolved, 0 unresolved, 0 parse failures. Then assert via raw SQL: `nodes` has exactly 2 rows, `edges` has exactly 1 row with source_id=main.id, target_id=formatName.id, kind='calls'.

2. **Re-index idempotency.** Same fixture as (1). Run `indexRepo` twice. Stats identical. Node count identical. Edge count identical. Proves `DELETE + re-insert` pattern is safe across runs.

3. **Test file excluded.** Fixture adds `src/main.test.ts` containing a function. After index, that function is not in the `nodes` table. Assert via `findNodesByFile(db, 'src/main.test.ts').length === 0`.

4. **`.d.ts` excluded.** Fixture adds `src/types.d.ts`. Same assertion.

5. **Empty repo.** Fixture is a directory with only ignored files (e.g. `node_modules/foo.ts`, `dist/bar.ts`). `indexRepo` returns `files: 0, functions: 0, calls: 0`. No throw. `.ctx/graph.db` file is created (empty schema).

6. **Path separator is POSIX.** Fixture has `src/nested/deep/foo.ts`. After index, `findNodesByFile(db, 'src/nested/deep/foo.ts')` returns the function. Note the `/` — if any layer used `\`, this query would miss. This is the Windows-correctness pin.

7. **Unresolved count correctness.** Fixture: `src/a.ts` that calls `externalThing()` without importing it and with no definition in the project. After index, `unresolved >= 1`. Specifically, `unresolved === calls - resolved` (sanity).

Runs as `node dist/verify-pipeline.js`, prints `OK` or throws.

CLI is not covered by verify (too shell-heavy). Manual check:
```bash
cd /path/to/some/repo
node dist/cli.js index .
node dist/cli.js stats
```

## Implementation order

1. Write `src/pipeline.ts`. `npx tsc --noEmit` clean.
2. Write `src/cli.ts`. `npx tsc --noEmit` clean.
3. Write `verify-pipeline.ts` with 7 scenarios.
4. `npx tsc && node dist/verify-pipeline.js` → `OK`.
5. `wc -l src/pipeline.ts src/cli.ts` → both under their targets.
6. Manual CLI smoke test on this very project (`node dist/cli.js index .`).

## Failure signals

- `src/pipeline.ts` exceeds 200 lines: pull `discoverFiles` into its own file.
- `src/cli.ts` exceeds 80 lines: refactor or drop features.
- Any function exceeds 20 lines: refactor.
- Any scenario fails: fix the code, never the assertion.
- Summary crashes with `NaN%` on zero-call repo: add the divide-by-zero guard.

No percentage thresholds for resolved rate. Most `unresolved` calls in real code are member chains (`console.log`, `arr.map`, `user.save`) and external imports — scope explicitly does not resolve them, so they are expected, not a bug. Staring at the raw numbers is fine; chasing a target percentage would push us to change resolver strategies, which we decided in the resolve plan we will not do without data.

## Deliberately not doing

- No watch mode (`--watch`, file system events).
- No incremental (`file_hashes` + change detection). always full rebuild.
- No `--include` / `--exclude` flags. Exclusion list is compiled into the binary.
- No progress output during run.
- No parallel / worker-thread extraction.
- No `clean` / `reset` / `drop` command. Delete the `.ctx/` directory manually.
- No search, query, MCP, or export commands. Those belong to a separate layer.
- No exit code other than 0 (success), 1 (CLI usage error or stats-without-index).
- No stderr usage except for CLI usage errors. All normal output goes to stdout.
- No dependency on `tsconfig.json`, `package.json`, or any project config inside the target repo.

## Verification

```bash
npm install                        # glob added to deps
npx tsc                            # clean
node dist/verify-pipeline.js       # prints "OK"
wc -l src/pipeline.ts src/cli.ts   # under 200 / 80

# manual smoke test
node dist/cli.js index .
node dist/cli.js stats
```

Expected on this project after smoke test: several nodes (the storage/extract/resolve functions), some calls, likely zero parse failures, unresolved count non-zero (we call `fs.*`, `path.*` which are external).

## Dependency to add

```json
"dependencies": {
  "glob": "^11.0.0"
}
```

Everything else already in `package.json` from previous layers.
