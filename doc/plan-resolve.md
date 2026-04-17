# Plan: Resolve Layer

## Context

Storage and extract layers are done. Next layer: resolve. Turns extract's string callees and module specifiers into concrete node-id references for the pipeline to write as `CALLS` edges.

## Decisions locked in

No separate `doc/resolve.md` — the plan is the spec.

1. **Only strategies 1 (`import_map`) and 2 (`same_module`) ship.** Strategies 3 (`unique_name`) and 4 (`suffix_match`) are heuristic without structural evidence and risk silent misattribution. Any unresolved call is better than a wrong edge. If real-world data later shows a resolvable pattern we're missing, design a targeted strategy then.
2. **No `confidence` anywhere.** Not on edges (already agreed in `doc/storage.md`), not in variables, not in comments. The strategy chain is priority order, not scoring. `codebase-memory`'s `0.95 / 0.90 / 0.75 / 0.55` numbers do not appear in this codebase.

   **Unresolved calls ARE classified, not counted as a monolith.** (Decision flipped from the original plan, which said "no classification". Reason below.) `resolveCall` returns either a `number` (node id) or `{ unresolved: UnresolvedReason }`. Six buckets:

   | bucket | condition | meaning |
   |---|---|---|
   | `member_chain` | callee contains `.` | not supported (no type info) |
   | `external` | import matched, `resolved_file === null` | outside project, unresolvable by definition |
   | `namespace_import` | import matched, `is_namespace` | not supported |
   | `default_import` | import matched, `is_default`, internal | not supported (external defaults already classified as `external`) |
   | `barrel_miss` | import resolved but registry missed | known known blind spot |
   | `unknown_bare` | no import match, same-file miss | usually JS built-ins or chain-break residue; project-name hits are real bugs |

   Judgment order (first match wins): `member_chain` → import match → (`external` → `namespace_import` → `default_import` → registry hit / `barrel_miss`) → (registry hit / `unknown_bare`). The `external` check precedes `is_default` / `is_namespace` on purpose: a default import resolving to `null` is indistinguishable from any other external call, and calling it `default_import` would falsely imply "this would be covered once we implement default resolution".

   **Why classification exists: the 28%-vs-97% reading problem.**

   Dogfood on this project yields 28% top-line resolved. That number is misleading because the denominator mixes three populations:

   - calls that **could in principle** hit project-internal code (named bare identifiers)
   - calls to **external infrastructure** (Node APIs, npm packages, JS built-ins)
   - **member chains** and **chain-break residue** that explicitly excludes

   Strip the second and third from the denominator — i.e., look only at calls that could plausibly refer to a project-internal function — and the hit rate on this project is **~97%**. The 69-point gap between 28% and 97% is entirely noise, not tool failure.

   The per-bucket breakdown exposes this directly. Reading rules:

   - `member_chain` large → expected in any TS codebase using Node APIs or OO patterns. Not a signal.
   - `external` > 0 → project depends on npm packages. Not a signal.
   - `barrel_miss` growing across runs → project uses barrel re-exports heavily; reconsider scope for that codebase.
   - `namespace_import` / internal `default_import` > 0 → project has patterns skipped; data for prioritizing future work.
   - `unknown_bare` containing recognizably-project names (not `Error`, `setTimeout`, `get`, `map`) → **real bug**. The registry missed something it should have found. Investigate.

   The top-line percentage stays in the summary for continuity, but the buckets are what you actually read.
3. **Import resolver returns a discriminated union.** `{ kind: 'resolved'; path: string } | { kind: 'external' }`. No sentinel strings, no nullable overloading.
4. **Registry is `Map<string, number>` keyed by `"${file}::${name}"`.** Double-key O(1) lookup. No `Map<name, Array<candidate>>` — that shape only exists to serve strategies 3/4, which are cut.
5. **Barrel re-exports are a known blind spot.** `export { foo } from './foo'` in an `index.ts` means the resolver sees `./utils` → `src/utils/index.ts`, registry has no `foo` in that file, strategy 1 misses. Not a bug, not scope. `verify-resolve.ts` has a scenario that **asserts the miss** so the blind spot is pinned in tests and won't silently "appear to work" later.

Additional scope decisions flowing from (1):

- **Only bare-identifier callees resolve.** If `callee` contains `.`, return `null` immediately. `obj.method()`, `utils.foo()`, `a.b.c()` are all unresolved. Method dispatch needs type info we don't have; namespace imports are uncommon enough to skip.
- **Only named imports count for strategy 1.** Default imports (`import X from './a'`) and namespace imports (`import * as X from './a'`) do not participate. Again: a well-defined surface is worth more than trying to cover every shape.

## Files

```
src/resolve.ts           # Registry + call resolver (pure, no I/O)  — target <80 lines
src/resolve-imports.ts   # Import resolver (fs-only)                — target <60 lines
verify-resolve.ts        # 14 scenarios, creates /tmp fixture tree for fs tests
```

Two files because call and import resolvers have different I/O profiles (pure vs filesystem). Keeping them apart makes `resolve.ts` testable with literal inputs and `resolve-imports.ts` the only thing that needs fixtures.

## `src/resolve-imports.ts`

```typescript
export type ResolvedImport =
  | { kind: 'resolved'; path: string }    // relative to projectRoot
  | { kind: 'external' }

export function resolveImport(
  specifier: string,
  importingFile: string,    // relative to projectRoot, e.g. 'src/models/order.ts'
  projectRoot: string,      // absolute
): ResolvedImport
```

Rules:
- If `specifier` does not start with `.` or `/`: `{ kind: 'external' }`. No node_modules walking, no tsconfig paths.
- Otherwise, resolve against `importingFile`'s directory. Try each of these in order, return the first that exists via `fs.existsSync`:
  1. `<resolved>.ts`
  2. `<resolved>.tsx`
  3. `<resolved>.js`
  4. `<resolved>.jsx`
  5. `<resolved>/index.ts`
  6. `<resolved>/index.tsx`
  7. `<resolved>/index.js`
  8. `<resolved>/index.jsx`
  9. `<resolved>` itself (specifier already had an extension)
- On success, return `{ kind: 'resolved', path: normalizeToPosix(path.relative(projectRoot, absolutePathFound)) }` where `normalizeToPosix(p) = p.split(path.sep).join('/')`. Registry keys are built with `/` by the pipeline on every platform; resolver output must match or Windows lookups silently miss.
- On all-miss (specifier starts with `.` or `/` but nothing exists): `{ kind: 'external' }`. Dangling relative import treated as external, not an error.

## `src/resolve.ts`

```typescript
export type Registry = Map<string, number>   // key: `${file}::${name}` → node id

export function buildRegistry(
  nodes: ReadonlyArray<{ id: number; file: string; name: string }>,
): Registry

export interface ResolverImport {
  local_name: string
  imported_name: string
  is_default: boolean
  is_namespace: boolean
  resolved_file: string | null   // null = external, set by the pipeline after import resolution
}

export function resolveCall(
  callee: string,
  callerFile: string,
  callerImports: ReadonlyArray<ResolverImport>,
  registry: Registry,
): number | null
```

Call resolution logic (strategy 1 then 2, stop at first hit):

1. If `callee.includes('.')`: return `null` (member chains not resolved).
2. Strategy 1 (import_map): find `imp` in `callerImports` where `imp.local_name === callee`.
   - If **any** import matches `local_name`, the programmer's intent is that import. Whether or not we can resolve the target, we do **not** fall through — falling through would silently re-attribute the call to an unrelated same-file function that happens to share the name.
   - If `imp.is_namespace`: return `null` (does not resolve namespace dispatch).
   - If `imp.is_default`: return `null` (does not resolve default imports).
   - If `imp.resolved_file === null`: return `null` (external target).
   - Else: return `registry.get(\`${imp.resolved_file}::${imp.imported_name}\`) ?? null`. A miss here is the barrel re-export case — return `null`, do not fall through.
3. Strategy 2 (same_module): reached only when **no import at all** matches `local_name`. Return `registry.get(\`${callerFile}::${callee}\`) ?? null`.

Rationale: any import that matches the callee name is structural evidence that the programmer meant that import. Our inability to resolve a specific case (namespace, default, external, barrel) does not downgrade that evidence — it just means returns `null` for this call. Falling through to same-module would attribute the call to a collision victim, which is exactly the silent misreport we are designed to avoid.

## `verify-resolve.ts` — scenarios

Top-level setup:
- Build `/tmp/ctx-resolve-test/` with a fixture file tree before running import-resolver scenarios.
- Tear down the tree on clean exit (not on throw — let the directory survive for debugging).
- Import-resolver scenarios use absolute root path.

Fixture tree:
```
/tmp/ctx-resolve-test/
  src/
    a.ts
    b/
      index.ts
      c.ts
    d.ts
```

### Import resolver (5 scenarios)

1. **Relative TS resolves**: `resolveImport('./a', 'src/app.ts', root)` → `{ kind: 'resolved', path: 'src/a.ts' }`.
2. **Directory index resolves**: `resolveImport('./b', 'src/app.ts', root)` → `{ kind: 'resolved', path: 'src/b/index.ts' }`.
3. **Nested relative resolves**: `resolveImport('./c', 'src/b/other.ts', root)` → `{ kind: 'resolved', path: 'src/b/c.ts' }`.
4. **Missing relative is external**: `resolveImport('./nope', 'src/app.ts', root)` → `{ kind: 'external' }`.
5. **Bare module is external**: `resolveImport('lodash', 'src/app.ts', root)` → `{ kind: 'external' }`.

### Call resolver (9 scenarios)

Registry for tests 6–14 built from three logical files:
- `src/a.ts`: `formatName` (id 1), `helper` (id 2)
- `src/app.ts`: `createOrder` (id 3)
- `src/utils/index.ts`: (empty — simulates a barrel)

6. **Named import resolves**:
   - callee: `'formatName'`, callerFile: `'src/app.ts'`
   - imports: `[{ local_name: 'formatName', imported_name: 'formatName', is_default: false, is_namespace: false, resolved_file: 'src/a.ts' }]`
   - → `1`.
7. **Aliased named import resolves**:
   - callee: `'fn'`, imports: `[{ local_name: 'fn', imported_name: 'formatName', is_default: false, is_namespace: false, resolved_file: 'src/a.ts' }]`
   - → `1` (registry lookup uses `imported_name`, not `local_name`).
8. **Same-module resolves**:
   - callee: `'createOrder'`, callerFile: `'src/app.ts'`, imports: `[]`
   - → `3`.
9. **Strategy 1 takes precedence over strategy 2**: same file has a `formatName` too (id 99 — simulate registry with both `src/a.ts::formatName=1` and `src/app.ts::formatName=99`), but callee is imported from `src/a.ts`. Resolve to `1`, not `99`.
10. **Member chain returns null**: callee `'obj.method'` → `null`, no strategies tried.
11. **Default import does not fall through (the critical one)**: callee `'X'`, imports `[{ local_name: 'X', imported_name: 'default', is_default: true, is_namespace: false, resolved_file: 'src/logger.ts' }]`. Registry **also** contains `src/app.ts::X = 77` (same file, same name — the collision trap). Assert strictly `null`, **not** `77`. This pins the fall-through fix.
12. **Namespace import does not fall through**: callee `'utils'`, imports `[{ local_name: 'utils', imported_name: '*', is_default: false, is_namespace: true, resolved_file: 'src/a.ts' }]`. Registry also has `src/app.ts::utils = 66`. Assert strictly `null`, **not** `66`.
13. **External import returns null (does not fall to strategy 2)**: callee `'axios'`, imports `[{ local_name: 'axios', imported_name: 'axios', is_default: false, is_namespace: false, resolved_file: null }]`, same-file registry would have `src/app.ts::axios=88` — still returns `null`.
14. **Barrel re-export is unresolved (the blind-spot pin)**:
    - callee `'foo'`, callerFile `'src/app.ts'`
    - imports `[{ local_name: 'foo', imported_name: 'foo', is_default: false, is_namespace: false, resolved_file: 'src/utils/index.ts' }]`
    - Registry has no `src/utils/index.ts::foo` (the barrel re-exports from elsewhere, which doesn't track)
    - → `null`. Assertion: strictly `null`, with a comment that this is the known known blind spot.

Runs as `node dist/verify-resolve.js`, prints `OK` or throws.

## Implementation order

1. Write `src/resolve-imports.ts`. `npx tsc --noEmit` clean.
2. Write `src/resolve.ts`. `npx tsc --noEmit` clean.
3. Write `verify-resolve.ts` with fixture-tree setup and all 14 scenarios.
4. `npx tsc && node dist/verify-resolve.js` → `OK`.
5. `wc -l src/resolve*.ts` → both under their targets.

## Failure signals

- `src/resolve.ts` exceeds 80 lines: refactor; do not split prematurely.
- `src/resolve-imports.ts` exceeds 60 lines: refactor.
- Any function exceeds 20 lines: refactor.
- Any scenario fails: fix the code, never the assertion.
- `confidence` appears anywhere in the diff, including comments: delete.

## Deliberately not doing

- `tsconfig.json` `paths` / `baseUrl` resolution.
- `node_modules` walking.
- Dynamic `import()`.
- CommonJS `require()`.
- Re-export transitive resolution (barrel files).
- Default-import resolution.
- Namespace-import resolution (`utils.foo`).
- Member-chain resolution (`obj.method`).
- Any heuristic that guesses without structural evidence.
- Confidence scores, strategy names in edge properties, or any rank metadata on edges.
- `.js → .ts` fallback (Node-ESM-TypeScript interop where `import './foo.js'` should resolve to `foo.ts`). treats `./foo.js` as external if the literal `.js` file is missing. Users relying on this pattern will see a lot of `external`. Documented, not supported.

## Verification

```bash
npx tsc                       # clean
node dist/verify-resolve.js   # prints "OK"
wc -l src/resolve.ts src/resolve-imports.ts
```
