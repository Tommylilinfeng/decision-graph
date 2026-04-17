# Plan: Extract Layer

## Context

Storage layer is done and verified. Next layer is the extractor, spec'd in `doc/extract.md`. Scope: turn `(source, language)` into `{ functions, imports }`. Nothing else.

Principles from `CLAUDE.md` that shape this plan:
- Single file (`src/extract.ts`) unless it exceeds 200 lines.
- Functions, not classes (no module-level mutable state other than the lazy-initialized parser cache).
- No `try/catch` that swallows errors. Parse errors are not swallowed, they are tolerated — tree-sitter returns a partial tree and we walk whatever we get. That is not the same as catching an exception.
- Zero comments by default.

## Files to create or modify

```
package.json                   # add web-tree-sitter, tree-sitter-wasms
src/extract.ts                 # the whole extract layer (target <200 lines)
verify-extract.ts              # smoke test (tsc -> node dist/verify-extract.js)
```

No new `src/` subdirectory, no barrel, no re-exports.

## Dependencies to add

```json
"dependencies": {
  "better-sqlite3": "^11.0.0",
  "web-tree-sitter": "^0.24.0",
  "tree-sitter-wasms": "^0.1.13"
}
```

`tree-sitter-wasms` ships pre-built `.wasm` grammars for ~40 languages including TypeScript, TSX, and JavaScript. Files live at `node_modules/tree-sitter-wasms/out/*.wasm`.

## `src/extract.ts` — layout

In this order:

1. Imports (`web-tree-sitter`, `path`, `require.resolve` for WASM locating).
2. Types re-stated from `doc/extract.md`: `Language`, `ExtractedFunction`, `ExtractedImport`, `ExtractResult`.
3. Module-level parser cache: `let parsers: { typescript, tsx, javascript } | null`. `null` until `initParser` runs.
4. `initParser(): Promise<void>` — idempotent, race-safe. If `parsers` is already populated, return immediately. If an in-flight init Promise exists (kept in a module-level `let initPromise: Promise<void> | null`), return it. Otherwise assign a new init promise to `initPromise`, inside it: load WASM runtime, load three grammars (`tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm`, `tree-sitter-javascript.wasm`), construct three `Parser` instances, assign to `parsers`. Concurrent callers all await the same promise.
5. `extractFromFile(source, lang): ExtractResult` — guard that `parsers` is not null (throw loud if not initialized). Select the parser, call `parse`, capture the `Tree` handle. Run `walkForFunctions(tree.rootNode)` and `walkForImports(tree.rootNode)`. **Call `tree.delete()` before returning** to free WASM-allocated memory (JS GC does not free it; pipeline-scale usage would leak the entire heap). Return `{ functions, imports }`.
6. `walkForFunctions(root): ExtractedFunction[]` — recurse the tree, extract at each top-level `function_declaration` / variable-declarator-with-arrow-or-function-expression. Inside each extracted function, call `collectCallsStoppingAtBoundary(body)` to get the calls list. Do NOT recurse the body walker into nested function boundaries.
7. `collectCallsStoppingAtBoundary(node): string[]` — **post-order traversal** (visit children first, then self). Collects `call_expression` and `new_expression` nodes into a flat list in traversal order, then renders each via `renderMemberChain`. Returns empty when entering a new function/arrow/method boundary (do not recurse). Post-order is required so that `getUser().save()` produces `['getUser', 'save']` rather than `['save', 'getUser']` — the inner call is rendered before the outer.
8. `renderMemberChain(node): string | null` — rules:
    - `identifier` → its text.
    - `member_expression` (object + `.` + property) → recursive render of object + `'.'` + property text.
    - **Optional chaining** (`a?.b?.c`): flatten `?.` to `.`. `a?.b?.c()` renders as `'a.b.c'`. Treat the optional-member node the same as `member_expression` for rendering.
    - **Computed access** (`a[b]`): return `null`. Cannot be rendered as a clean dotted chain. The caller skips this call.
    - **Call as object** (`getUser().save`): return just the property text (`'save'`). Breaks the chain at the call; the inner call is picked up separately by the post-order walker.
    - **Template tag call** and all other callee shapes: return `null`, skipped.
9. `walkForImports(root): ExtractedImport[]` — iterate top-level (and only top-level) `import_statement` nodes. For each, read the `source` string (module_specifier), then walk the import clause to collect each binding. Produce one `ExtractedImport` per binding.
10. Small helpers: `lineOf(node): number` (returns `node.startPosition.row + 1`), `stripQuotes(s: string): string`.

## Tree-sitter node types we rely on

From tree-sitter-typescript and tree-sitter-javascript grammars (same names in both):

**Function definitions**:
- `function_declaration` (with field `name`)
- `variable_declarator` (with field `name` and field `value`; value may be `arrow_function`, `function_expression`, or `function`)
- `lexical_declaration` wraps the above at statement level — walk its children

**Call sites**:
- `call_expression` (with field `function`)
- `new_expression` (with field `constructor`)

**Member chains**:
- `identifier`
- `member_expression` (with field `object` and field `property`)

**Imports**:
- `import_statement` with a string `source` child
- `import_clause` children: `identifier` (default), `namespace_import`, `named_imports`
- `named_imports` contains `import_specifier` nodes (field `name`, optional field `alias`)
- `namespace_import` contains an `identifier`

Function boundaries that stop the body walker (option c per `doc/lambda-attribution.md` — only **named** nested scopes stop the walker; anonymous lambdas are walked into):
- `function_declaration`
- `generator_function_declaration`
- `method_definition`

Walked into (NOT boundaries):
- `arrow_function`
- `function_expression`
- `function` (bare `function() {}`)
- `generator_function`

## `verify-extract.ts` — scenarios

Each scenario passes a literal TS source string through `extractFromFile` and asserts the result. No filesystem. No fixtures directory.

1. **Simple function declaration**: `function foo() { bar() }` → one function `foo` with `calls: ['bar']`, `start_line: 1`, `end_line: 1`.
2. **Arrow assigned to const**: `const foo = () => { bar() }` → one function `foo` with `calls: ['bar']`.
3. **Function expression assigned to const**: `const foo = function() { bar() }` → one function `foo` with `calls: ['bar']`.
4. **Member chain calls**: `function f() { a.b.c(); x.y() }` → `calls: ['a.b.c', 'x.y']`.
5. **new expression**: `function f() { new Foo() }` → `calls: ['Foo']`.
6. **Chained call breaking the chain**: `function f() { getUser().save() }` → `calls: ['getUser', 'save']` (two entries, post-order: inner call rendered before outer).
7. **Call duplication preserved**: `function f() { a(); a(); a() }` → `calls: ['a', 'a', 'a']`.
8. **Lambda call attribution (option c)**: `function outer() { items.map(item => validate(item)) }` → `outer.calls` is `['validate', 'items.map']` — the inner call is attributed to the enclosing named function; post-order so inner emits before outer. See `doc/lambda-attribution.md`.

8b. **Nested named function is still a boundary**: `function outer() { function inner() { bar() }; inner() }` → `outer.calls` is `['inner']` — calls inside nested named functions do not bubble up.

8c. **Transaction-style callback (dogfood motivator)**: `function indexRepo() { db.transaction(() => { writeGraph() })() }` → `indexRepo.calls` includes `'writeGraph'`.
9. **Top-level calls dropped**: `const x = loadConfig(); function f() { use(x) }` → one function `f`, `calls: ['use']`; `loadConfig` does not appear anywhere.
10. **1-indexed line numbers**: a function starting on the first line of the source has `start_line: 1`, not `0`.
11. **TSX parses with real call**: `function App() { useEffect(); return <div /> }` (passed with `language: 'tsx'`) → one function `App`, `calls: ['useEffect']`. Hard assertion — no weasel words. Proves both that TSX grammar loads and that calls inside a TSX function body are extracted.
12. **Named imports**: `import { foo, bar } from './a'` → two imports, both with `module_specifier: './a'`, `is_default: false`, `is_namespace: false`, `imported_name` values `'foo'` and `'bar'`.
13. **Default import**: `import X from './a'` → one import, `imported_name: 'default'`, `is_default: true`, `local_name: 'X'`.
14. **Namespace import**: `import * as X from './a'` → one import, `imported_name: '*'`, `is_namespace: true`, `local_name: 'X'`.
15. **Default + named mixed**: `import X, { a, b } from './c'` → three imports (one default, two named).
16. **Alias in named import**: `import { foo as bar } from './a'` → one import, `imported_name: 'foo'`, `local_name: 'bar'`.
17. **Parse failure tolerance**: `function broken( {` (invalid source) → call does not throw. Returned value has shape `{ functions, imports }` where both are arrays (possibly empty). Asserts both the exception-boundary contract and the return-shape contract.
18. **Optional chain call**: `function f() { user?.profile?.save() }` → `calls: ['user.profile.save']` (flattened).
19. **Computed-access call is skipped**: `function f() { a[b]() }` → `calls: []` (rendered null, skipped).

Runs as `node dist/verify-extract.js`, prints `OK` or throws.

Additionally, the script calls `initParser()` twice at the top and confirms both calls resolve without error — the second call must not re-load WASM (observable by it returning essentially instantly). This proves the idempotency contract.

## Implementation order

1. Edit `package.json`, add `web-tree-sitter` and `tree-sitter-wasms`. Run `npm install`.
2. Verify the three WASM files exist at `node_modules/tree-sitter-wasms/out/tree-sitter-{typescript,tsx,javascript}.wasm`.
3. Write `src/extract.ts`. Build mental model first: grammar names of the handful of nodes we touch. Then type the code.
4. `npx tsc --noEmit` → clean.
5. Write `verify-extract.ts` with all 19 scenarios.
6. `npx tsc && node dist/verify-extract.js` → `OK`.
7. `wc -l src/extract.ts` → under 200.

## Failure signals

- `src/extract.ts` exceeds 200 lines: split `walkForImports` into its own file.
- Any function exceeds 20 lines: refactor or inline helpers.
- `initParser` has to retry or race: something is wrong with our lazy-init approach.
- Any scenario fails: diagnose and fix. Do not adjust the assertion to pass.
- Tree-sitter returns a node type we did not expect (e.g., `variable_declaration` instead of `lexical_declaration` in some grammar version): add the alias, do not guess.

## Deliberately not doing

- No CLI.
- No streaming / large-file optimization (we parse one file at a time, sync).
- No error recovery reporting — partial trees are used silently.
- No position caching across calls. Parser instances are cached at module scope; per-file trees are explicitly freed via `tree.delete()` before `extractFromFile` returns. JS GC does not free WASM-allocated memory — this is an intentional, must-not-forget step.
- No test framework. `verify-extract.ts` is sufficient.
- No exports of the raw tree-sitter types from `src/extract.ts` (keep `web-tree-sitter` a private dependency of this file).
- No node_modules path hardcoding — use `require.resolve('tree-sitter-wasms/package.json')` to find the WASM directory portably.

## Verification

```bash
npm install
npx tsc                     # clean
node dist/verify-extract.js # prints "OK"
wc -l src/extract.ts        # < 200
```

## Notes from implementation

`web-tree-sitter@0.26` rejected the `.wasm` files shipped in `tree-sitter-wasms@0.1.13` with a `getDylinkMetadata failIf` error — newer runtime, older grammar ABI. Pinned to `web-tree-sitter@^0.24` which matches the grammar format. That version uses a default export and `Parser.Language` / `Parser.SyntaxNode` namespace (not named exports like 0.26).

Extract layer ended up at 159 lines in `src/extract.ts` + 70 lines in `src/extract-imports.ts` (split per the failure signal).
