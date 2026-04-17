# Lambda Call Attribution

## Problem

A function's call list should reflect what that function can reach. When a call sits inside a lambda passed to another function, the current extractor drops it. For modern TypeScript, that is the majority case.

`doc/extract.md` locked in option b ("stop at boundary, drop the calls") with the reasoning that option c ("attribute inner calls to outer") is a silent lie. This document reverses that decision and records why.

## Live evidence

Dogfood on this project produced this call for `indexRepo` (simplified from `src/pipeline.ts`):

```ts
function indexRepo() {
  const stats = db.transaction(() => {
    db.exec('DELETE FROM nodes')
    return writeGraph(db, parsed, perFileImports)
  })()
}
```

`writeGraph` is the central write step of the whole pipeline. `db.transaction(() => ...)` runs the callback synchronously — the call happens, every time `indexRepo` runs.

Under option b:
- `indexRepo.calls = ['db.transaction']` (the outer call only)
- `db.transaction` is a member chain, dropped by the resolver
- Resulting edges from `indexRepo`: **zero**

The graph claims `indexRepo` calls nothing. Ask "who calls `writeGraph`?" — answer is the empty set. This is the project's own orchestrator.

Eleven files were dogfooded. 403 total calls, 112 resolved (28%). A large part of that loss is member chains and external imports (both intentional per the v1 scope). The rest is this: real project-internal calls hidden inside lambdas.

## Three options

**(a) Separate node for each lambda.** Emit a node `indexRepo$1` for the arrow, plus a new edge kind `contains` from `indexRepo` to `indexRepo$1`. The lambda node's call list is accurate; `writeGraph` appears as `indexRepo$1 -> writeGraph`. Answering "does `indexRepo` reach `writeGraph`?" requires a two-hop traversal through the containment edge.

Cost:
- Storage schema needs a new edge kind (`contains`) and relaxed node constraints to hold anonymous names.
- Resolver has to skip anonymous nodes for decision anchoring, or decide whether decisions can attach to them.
- Any query that wants "what functions are reachable from X" becomes a graph walk rather than a single-edge lookup.

Correctness: highest. `button.onClick = () => deleteUser()` records `setup contains setup$1`, `setup$1 calls deleteUser` — the wiring and the invocation are separate facts, which they are.

**(b) Stop at boundary, drop the calls.** The current state. Zero misattribution, large coverage loss. Failed the project's own dogfood.

**(c) Walk into lambdas, attribute their calls to the enclosing named function.** One line change in the extractor. `indexRepo.calls` picks up `writeGraph` directly. Edges from `indexRepo` include a `calls -> writeGraph` row.

Cost: a narrow class of inaccuracy. When a lambda is assigned as a handler rather than invoked:

```ts
function setup() {
  button.onClick = () => deleteUser()
}
```

Option c records `setup -> deleteUser`. Strictly, `setup` does not call `deleteUser`; it installs a handler that the user may or may not trigger. The graph says "setup can reach deleteUser", which is true in the weak sense ("a path through setup may eventually fire deleteUser") but false in the strict sense ("setup invokes deleteUser as part of its execution").

## Decision

Option c.

Rationale:

- The tool's purpose is decision anchoring and reachability questions for Claude Code, not strict control-flow analysis. "What functions are related to this code path?" is the query; "does this function invoke that one synchronously?" is not.
- The cases option c gets right (synchronous callbacks: `db.transaction`, `.map`, `.forEach`, `Array.from`, `Promise.then`, React hooks, test harnesses) vastly outnumber the cases it gets wrong (handler assignment). Every TypeScript codebase is full of the first; the second is rare enough that misattributing it is not a debugging crisis.
- Option b's zero-misattribution guarantee sounded principled in the plan. The live graph proves the guarantee costs more than the error it prevents. Missing `indexRepo -> writeGraph` is a worse bug than overstating `setup -> deleteUser`.
- Option a is a v1.x project, not a v1 patch. Anonymous nodes, containment edges, and decision-anchor ambiguity each deserve their own design pass.

## Accuracy caveat accepted

Option c overstates reachability for lambdas used as stored references rather than inline invocations. Known patterns:

- Event handler assignment: `el.onclick = () => f()`
- React/Vue props passing callbacks down
- `setTimeout(() => f(), 1000)` — the call happens, but async and possibly never
- Storing callbacks in data structures for later dispatch

The graph treats all of these as "outer calls f". Callers of this graph must read edges as "reaches" rather than "invokes synchronously".

This caveat is documented, not worked around. When a real use case demands the distinction, we reach for option a at that point.

## Boundary still held

Option c does not mean "remove all scope boundaries". Nested **named** function declarations and class methods remain their own scopes:

```ts
function outer() {
  function inner() { bar() }    // bar attributed to inner (if inner were tracked); not to outer
  inner()                        // outer.calls contains 'inner'
}
```

In v1, `inner` is not extracted as a top-level function (v1 tracks only top-level), so its internal calls simply disappear. Option c does not change that — we still stop at `function_declaration`, `generator_function_declaration`, and `method_definition`. We only stop walking into `arrow_function`, `function_expression`, `function` (anonymous), and `generator_function`.

The distinction is semantic: a named nested function is a programmer-declared scope with its own identity. An anonymous lambda passed to another function is a piece of inline behavior with no standalone identity — attributing its calls to the enclosing named function is the closest thing we have to truth.

## When to revisit

Revisit option a if any of the following:

- Decision anchoring needs to target the lambda body specifically (a decision that applies only to what happens inside `db.transaction(cb)`, not to `indexRepo` as a whole).
- A query emerges that requires distinguishing "synchronously invokes" from "stores for later invocation".
- Dogfooding on handler-heavy code (UI frameworks, event-driven systems) produces an edge count inflated by false positives to the point of distorting reachability answers.

None of these are present today. If they appear, the upgrade path is: add node kind `lambda`, add edge kind `contains`, stop walking into lambdas, emit containment edges instead. Existing `calls` semantics for named functions do not change.

## Related docs to update

- `doc/extract.md` — "Nested functions" section reflects option b; flip to option c with a pointer here.
- `doc/plan-extract.md` — scenario 8 asserts the boundary; scenario flipped in `verify-extract.ts`.
