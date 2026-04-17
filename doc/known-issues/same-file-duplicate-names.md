# Same-File Duplicate Function Names Drop Silently After the First

## Status

**Fires when the input code has it.** Not latent. Current behavior is deliberate but lossy, and the loss is not obvious from the summary output.

## Summary

When a single file declares two or more top-level functions with the same name, the extractor's `dedupeByName` keeps the **first** occurrence and drops every subsequent one. The dropped function's body, line range, and call list all disappear from the graph. Any call that was meant to target function #2 silently routes to function #1.

## Why this exists

Storage identity is `(file, name)` — see `doc/storage.md` under "Identity is `(file, name)`, not `(file, start_line, name)`". Two functions with the same name in the same file would collide on `UNIQUE (file, name)` at insert time. Without pre-deduplication, `upsertNodes` would throw partway through the batch, aborting the whole transaction.

Extract resolves the collision at the source: dedupe before the rows ever reach storage, and surface the collision through `duplicateFunctionNames` so the pipeline can warn.

## What the user sees

The CLI summary includes a line like:

```
Indexed 11 files in 0.0s
  53 functions
  ...
  1 duplicate function names dropped: src/legacy.js::foo
```

The programmatic surface is `PipelineResult.duplicateWarnings: Array<{ file, name }>`.

## What the user does **not** see

Three loss surfaces, in order of bite:

1. **The dropped function's calls are gone.** If the two `foo` functions have different bodies, one of them — whichever appears later in the file — contributes no outbound edges. The graph answers "what does foo call?" with function #1's calls only.

2. **Inbound calls misattribute.** Every call to `foo` from anywhere (same file, imported from elsewhere) resolves to function #1's node id, because it's the only `foo` in the registry. If the caller actually wrote code targeting function #2 (which is rarely the intent, but possible in complex patching scenarios), the edge is pointed at the wrong body.

3. **Line-range lookups miss.** `findNodeAtLine(file, someLineInFunction2)` returns nothing — function #2's line range was never stored. If a decision hook targets a line inside the dropped function, it cannot anchor.

## When this triggers in practice

- **Generated code.** Code generators occasionally emit duplicate function declarations, especially when merging templates.
- **JavaScript with loose naming.** JS allows redeclaring `function foo()` at the same scope; TS rejects it, but mixed-language repos still have both.
- **Migrations.** Partial refactors where old and new versions of the same function coexist during a transition.
- **`if/else` function declarations** in older JS (`if (env === 'prod') { function foo() { ... } } else { function foo() { ... } }`). Hoisting rules vary; the extractor sees both and dedupes.

In hand-written strict-TS codebases this almost never fires. `duplicateWarnings.length === 0` on the project's own dogfood.

## Alternatives considered

### Throw on collision

Fail the whole `index` run if any file has a duplicate. **Rejected**: makes the tool refuse to work on legacy and generated code for a problem that affects one file out of hundreds. The tool's purpose is to be useful on real repos, including messy ones.

### Store all duplicates under mangled names (`foo`, `foo$1`, `foo$2`)

Preserves every body. **Rejected**:
- `resolveCall('foo', ...)` becomes ambiguous: which `foo` does a caller mean? There is no structural evidence to pick one, and v1's resolver explicitly refuses to guess without evidence.
- Decision anchors would have to disambiguate between `foo` and `foo$1` — but the source code has one `foo`, not two named entities. The mangling is our invention, not the programmer's.
- Line-range lookup (`findNodeAtLine`) would have to pick one anyway, regressing to the same first-wins choice for that query.

### Extend identity to `(file, name, start_line)`

Each duplicate gets its own row. **Rejected** for the reason `doc/storage.md` already locks in: a single blank-line edit shifts every function's `start_line`, making identity unstable and cascade-deleting every inbound edge in the file. This is the exact bug the current identity scheme exists to prevent.

### Keep last instead of first

Same loss surface, different arbitrary pick. **Rejected**: no principled reason to prefer later over earlier. First-wins matches the reading order a human would use when scanning the file.

### Current: keep first, warn

`duplicateWarnings` surfaces the name and file. The pipeline prints the count in its summary. Callers who care can inspect the raw list. The graph remains internally consistent (every edge has a valid target; no dangling references).

## What the user can do today

- Check `duplicateWarnings` after an index run. Non-empty means the graph has lost data for the listed names.
- Rename the duplicates in source. This is almost always the correct fix; duplicate top-level function names are a code smell even when syntactically legal.
- Accept the loss for ephemeral/generated code where renaming is not an option. Understand that calls routing through those names are unreliable.

## When this document becomes obsolete

- **When identity extends to `(file, parent, name)`** as part of adding classes and methods. Top-level duplicates would still collide; nothing about that piece of the problem changes. This document stays.
- **When incremental indexing ships with a "treat duplicates as a hard error" CLI flag.** Users who want strictness opt in; the default stays lenient. This document stays, describing the default.
- **When the tool changes identity semantics**. Then this document is rewritten to describe the new behavior, and the first paragraph of `doc/storage.md`'s identity section points here instead of the other way around.
