# Extract Layer

## What it does

Turn a source file into two lists:
- **Functions** — each with a name, line range, and the call expressions inside it.
- **Imports** — each with a local name, imported name, and the module specifier as written.

That is the whole job. One `(source, language)` input, one plain-object output.

## What it does not do

- Read files (the pipeline reads, passes the string in).
- Touch the filesystem, the database, or any other I/O.
- Resolve imports to files (`pipeline/` does that with `fs`).
- Resolve calls to definitions (`resolve/` does that against the node registry).
- Filter built-in names (`console.log`, `Array.map`, etc. — caller decides).
- Deduplicate calls (storage's `INSERT OR IGNORE` on edges handles that).
- Process classes, methods, interfaces, type aliases, enums (v1 scope is functions).
- Process nested functions (see the nested-function decision below).
- Log parse errors (returns whatever partial tree it gets; logging is the pipeline's call).

## Supported languages

- TypeScript (`.ts`)
- TSX (`.tsx`)
- JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`)

All three load a separate tree-sitter WASM grammar. The caller passes a `language` tag; file extensions are the pipeline's problem, not the extractor's.

## Public API

```typescript
export type Language = 'typescript' | 'tsx' | 'javascript'

export interface ExtractedFunction {
  name: string
  start_line: number  // 1-indexed, inclusive
  end_line: number    // 1-indexed, inclusive
  calls: string[]     // full member chains, in source order, not deduplicated
}

export interface ExtractedImport {
  local_name: string       // the identifier bound in the importing file
  imported_name: string    // the name exported by the target module; 'default' for default import; '*' for namespace
  module_specifier: string // the raw string in the import source
  is_default: boolean
  is_namespace: boolean
}

export interface ExtractResult {
  functions: ExtractedFunction[]
  imports: ExtractedImport[]
}

export function initParser(): Promise<void>
// Must be called once before any extractFromFile call. Loads WASM runtime + grammars.

export function extractFromFile(source: string, language: Language): ExtractResult
// Synchronous after initParser resolves. Pure function over the string.
```

Two functions. Nothing more.

## Design decisions

### Nested functions: walk into lambdas, stop at named scopes

```ts
const outer = () => {
  return items.map(item => validate(item))
}
```

We attribute calls inside anonymous lambdas to the enclosing named function (option c in `doc/lambda-attribution.md`). `outer.calls` contains `validate` and `items.map`.

The body walker stops only at **named** nested scopes: `function_declaration`, `generator_function_declaration`, `method_definition`. It walks **into** `arrow_function`, `function_expression`, `function` (anonymous), and `generator_function` — these are treated as inline behavior belonging to the enclosing function.

Consequence: edges read as "reaches" rather than "invokes synchronously". A handler assignment like `button.onclick = () => deleteUser()` produces an edge from the enclosing function to `deleteUser`, even though the actual invocation happens only when the user clicks. This is the accepted inaccuracy — `doc/lambda-attribution.md` documents why.

The earlier decision (option b, stop at every function boundary) failed the project's own dogfood: `indexRepo -> writeGraph` disappeared because `writeGraph` sat inside `db.transaction(() => ...)`. The reversal is recorded in `doc/lambda-attribution.md`.

### Calls are full member chains

```ts
foo()              // calls: ['foo']
obj.method()       // calls: ['obj.method']
a.b.c()            // calls: ['a.b.c']
getUser().save()   // calls: ['getUser', 'save']   — two expressions
new Foo()          // calls: ['Foo']
```

The extractor does not split `obj.method` into receiver and property. It does not decide whether `obj.method` should match `method` in the registry. Both are resolver problems. Giving the resolver the full chain preserves information; giving it only the last segment throws information away.

For call expressions where the callee is itself a call expression (`getUser().save()`), the chain breaks at the call. Two entries: `getUser` (the inner call) and `save` (the outer call's property). Source order.

### Imports are extracted, not resolved

Parsing an `import` statement is a tree-sitter task. Resolving `'./user'` to `src/models/user.ts` is a filesystem task. The parsing half happens here; the resolving half happens in the pipeline with `fs.existsSync` and extension probing.

Each `import_statement` contributes one `ExtractedImport` per imported binding:
- `import { x, y } from './a'` → two imports with `imported_name: 'x'`, `imported_name: 'y'`.
- `import x from './a'` → one import with `imported_name: 'default'`, `is_default: true`.
- `import * as x from './a'` → one import with `imported_name: '*'`, `is_namespace: true`.
- `import x, { y } from './a'` → default + named, two imports.

CommonJS `require()` is not extracted in v1. Real TS projects are ESM. If we hit a CJS file, those calls become bare `require` entries in `calls`, which resolvers will fail to resolve. That is fine.

### Line numbers are 1-indexed, closed interval

tree-sitter's native `row` is 0-indexed. The extractor adds 1 before returning.

Rationale: editors, `grep -n`, Claude's line citations, and the eventual decision hooks all speak 1-indexed. Storing and exposing the number that a human sees in their editor removes a whole class of off-by-one bugs across the rest of the system.

`start_line` and `end_line` are both inclusive — a function declared on line 10 to line 20 has `start_line: 10, end_line: 20`. Matches `findNodeAtLine`'s `start_line <= ? AND end_line >= ?` semantics in `storage.ts`.

### Top-level bare calls are dropped

```ts
const config = loadConfig()  // top level, no enclosing function
```

This `loadConfig` call has no `ExtractedFunction` to live inside. v1 drops it. Reasoning: the decision hook anchors to a function; a top-level statement is not a function to anchor to. If we later want "module-initialization" semantics, we add a virtual module node in the pipeline.

### Parse failures are silent

tree-sitter is error-tolerant: on a syntax error, it returns a partial tree with `ERROR` nodes. The extractor walks whatever it got and returns the functions and imports it could find. No warnings, no throws, no `console.error`. The pipeline decides whether to log based on its own context (CLI verbosity, hook-quiet mode, etc.).

### No call deduplication

```ts
function x() { a(); a(); a() }
// calls: ['a', 'a', 'a']
```

Storage enforces uniqueness at the edge level via `PRIMARY KEY (source_id, target_id, kind)`. Deduplicating in the extractor would throw away source order, which the resolver may want for its own ranking. Let the triplicate `'a'` entries ride through and collapse at the SQL layer.

## Known limitations

- **No CommonJS `require`.** v1 is ESM-only.
- **No dynamic imports.** `import('./x')` is not extracted.
- **No classes, methods, interfaces, type aliases, enums.** v1 is functions only.
- **No nested named functions.** `function inner() {}` declared inside another function is not extracted as a standalone node; its calls are dropped, not attributed to the outer scope. Anonymous lambdas are handled differently — see the nested-functions decision above.
- **No top-level calls.** Calls outside any function are dropped.
- **No JSX-specific extraction.** We parse TSX so we do not fail, but we do not treat JSX elements as anything special — only the JS/TS expressions inside curlies produce calls.

## When the extractor changes

- **Add a language**: add the grammar `.wasm`, add the enum value, add a parser instance. No other layer changes.
- **Add classes/methods**: grows `ExtractedFunction` into a union with `ExtractedClass` / `ExtractedMethod`. Storage gets a `parent` column (see `doc/storage.md`). Pipeline gets extended to emit the parent.
- **Add nested functions**: option a from the decisions above. Every inner function becomes its own `ExtractedFunction` with a generated name. Resolver has to decide how to handle anonymous callers.
