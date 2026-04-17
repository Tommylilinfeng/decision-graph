# Plan: MCP Server (C2 Capture Layer)

> **Tool surface superseded.** Schema, validation, and tool list rewritten in `doc/plan-alert-keywords.md` (`record_decisions` v2 with `decision`/`keywords`). Read tools added in `doc/plan-consumption.md` (`reset_decision_cache`, `decisions_by_keyword`). Server lifecycle, error layering, and batching/atomicity rationale here are still current.

## Context

Decision storage and API are done (`doc/plan-decisions.md`). This layer exposes the write side over Model Context Protocol so Claude Code can record decisions during a session. **Write only.** Reads belong to a future C3 layer.

## Principles from `CLAUDE.md` that shape this plan

- Minimize MCP tool count to minimize per-turn context cost. One tool, `record_decision`.
- Validate at system boundaries: the MCP argument is a system boundary. Everything downstream trusts the validated input.
- Per-tool permission is Claude Code's job, not ours. We expose the tool; the client decides prompt/allow/deny.
- No `try/catch` that swallows errors. User-input errors are structured (tool response `isError: true`); unexpected errors bubble to JSON-RPC.

## Scope

- Single binary started via `node dist/src/mcp.js <project-root>`
- Opens `<project-root>/.ctx/graph.db` at startup; exits 1 if the file does not exist
- Registers one tool: `record_decision`
- Thin wrapper: argument validation + call into existing `createDecision`
- Returns `"recorded decision <id>"` text; structured error on validation failures

## Preconditions verified

- Package is named `context-chain`; binary is `context-chain`; CLI subcommand is `index`. Error message `run \`context-chain index <root>\` first` is accurate.
- `tsconfig.json` `include: ["src/**/*", "verify*.ts"]` — new `verify-mcp.ts` auto-matched.
- `@modelcontextprotocol/sdk` is the official Anthropic SDK on npm. Installed as a runtime dependency.

## Files to create or modify

```
src/mcp.ts                    # server entry + tool registration + handler
verify-mcp.ts                 # unit tests for handleRecordDecision (not MCP protocol)
doc/mcp.md                    # setup guide
package.json                  # add @modelcontextprotocol/sdk; extend verify script
```

No separate handler file — `handleRecordDecision` is exported from `src/mcp.ts` and imported by `verify-mcp.ts`. Only one consumer per file exists; a third file would be ceremony.

## Startup

```typescript
async function main(): Promise<void> {
  const root = process.argv[2]
  if (!root) {
    process.stderr.write('usage: context-chain-mcp <project-root>\n')
    process.exit(1)
  }
  const dbPath = path.join(root, '.ctx', 'graph.db')
  if (!fs.existsSync(dbPath)) {
    process.stderr.write(
      `context-chain: no index at ${root}\n` +
      `run \`context-chain index ${root}\` first\n`
    )
    process.exit(1)
  }
  const db = openDatabase(dbPath)
  // ... server setup, graceful shutdown on SIGTERM/SIGINT ...
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
```

**Key decision**: hard-fail when `.ctx/graph.db` is missing. Do **not** check `SELECT COUNT(*) FROM nodes` — that would wrongly reject valid empty-repo workflows where users anchor decisions at file level on a codebase that is legitimately index-able but contains zero functions (config-only repos, type-declaration-only libraries). The file existence check is enough to catch "user forgot to index".

## Error layering

```typescript
class DecisionValidationError extends Error {}
```

- **User input bad** (missing summary, empty anchors, function without name, file with name, invalid kind): throw `DecisionValidationError` inside `validateArgs`. MCP handler catches it and returns:
  ```json
  { "content": [{ "type": "text", "text": "<message>" }], "isError": true }
  ```
  Claude sees the error text and can retry.

- **Anything else** (db crash, FS error, SDK bug): let the exception bubble. MCP SDK turns it into a JSON-RPC error. Claude Code sees "tool broken" — session may degrade.

This distinction matters because Claude's behavior differs between the two: a tool-response error is a recoverable "tool said no", a JSON-RPC error is "tool is unavailable".

## Tool schema (deliberately permissive)

```typescript
{
  name: 'record_decision',
  description: 'Record a design decision about code and anchor it to functions or files. Use when the user states a design choice, constraint, or rationale that should persist across sessions. Decisions anchored to functions ride the call graph; file-level decisions apply to a whole file.',
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      context: { type: 'string' },
      anchors: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['function', 'file'] },
            file: { type: 'string' },
            name: { type: 'string', description: 'required when kind=function; omit when kind=file' }
          },
          required: ['kind', 'file'],
        },
      },
    },
    required: ['summary', 'anchors'],
  },
}
```

**Permissive schema** (flat anchor object, `name` optional at JSON-schema level) rather than strict `oneOf` discriminated union. Rationale:

- Strict `oneOf` schema is ~200 tokens inflating every turn's context.
- Permissive schema is ~120 tokens, with server-side validation catching invalid shapes.
- Claude retries quickly on validation errors; ~50 tokens per retry beats ~100 extra tokens per turn.

The `name` field's `description` documents the kind-specific requirement inline so Claude can get it right on the first call most of the time.

## Handler

```typescript
export function handleRecordDecision(db: Db, rawArgs: unknown): string {
  const input = validateArgs(rawArgs)
  const id = createDecision(db, input)
  return `recorded decision ${id}`
}
```

**Return value**: `recorded decision <id>`. The id is worth the ~10 tokens — Claude can reference decisions by id in subsequent conversation, and users asking "delete that last decision" have a handle.

**`validateArgs(raw: unknown): CreateDecisionInput`** — approximately 25 lines. Throws `DecisionValidationError` with a descriptive message on:
- Missing or empty `summary`
- Missing or empty `anchors`
- Any anchor not being an object
- `kind` not `'function'` or `'file'`
- `kind === 'function'` without a non-empty `name`
- `kind === 'file'` with a `name` field present (prevents inconsistent input)
- Missing or empty `file`

Also reads `process.env.CONTEXT_CHAIN_SESSION_ID` and sets it on the returned `CreateDecisionInput` when present.

## MCP wiring

```typescript
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'record_decision') {
    throw new Error(`unknown tool: ${req.params.name}`)
  }
  try {
    const text = handleRecordDecision(db, req.params.arguments)
    return { content: [{ type: 'text', text }] }
  } catch (e) {
    if (e instanceof DecisionValidationError) {
      return {
        content: [{ type: 'text', text: e.message }],
        isError: true,
      }
    }
    throw e
  }
})

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [ /* schema above */ ],
}))
```

## `verify-mcp.ts` — 9 scenarios

All call `handleRecordDecision` directly. **No MCP protocol exercised.**

Setup: `/tmp/ctx-verify-mcp.db` with two nodes — `src/a.ts::foo`, `src/b.ts::bar`.

1. **Happy function anchor**: valid args → returns `recorded decision <id>`; `decisionsForFunction('src/a.ts', 'foo')` finds it
2. **Happy file anchor**: `kind: 'file'` with no name → success
3. **Mixed anchors**: function + file in one call → all stored
4. **Missing summary**: → throws `DecisionValidationError`, message includes "summary"
5. **Empty anchors array**: → throws `DecisionValidationError`
6. **Function anchor missing name**: → throws `DecisionValidationError`, message includes "name"
7. **File anchor with name**: → throws `DecisionValidationError` (prevents inconsistent input)
8. **Invalid kind** (e.g., `kind: 'directory'`): → throws `DecisionValidationError`
9. **Session env propagation**: set `process.env.CONTEXT_CHAIN_SESSION_ID = 'sess-xyz'`, call handler, verify stored `decisions.session_id === 'sess-xyz'`, then `delete process.env.CONTEXT_CHAIN_SESSION_ID`

All throw-assertions check the error is an instance of `DecisionValidationError`, not just any Error.

**Not tested**:
- MCP protocol layer (list/call JSON-RPC roundtrip) — SDK's responsibility
- Startup `existsSync` check — stderr + process.exit is awkward to test in-process; covered by manual smoke
- DB crash exception bubbling — requires mocking, not worth it

## Dependencies

```json
"dependencies": {
  "@modelcontextprotocol/sdk": "^1.0.0"
}
```

~150KB minified. Acceptable.

## `package.json` verify script

Extend from:
```
"verify": "tsc && node dist/verify.js && node dist/verify-extract.js && node dist/verify-resolve.js && node dist/verify-pipeline.js"
```

To:
```
"verify": "tsc && node dist/verify.js && node dist/verify-extract.js && node dist/verify-resolve.js && node dist/verify-pipeline.js && node dist/verify-decisions.js && node dist/verify-mcp.js"
```

## `doc/mcp.md`

~100 lines, sections:

1. **Overview** — single tool `record_decision`; write-only in v1; reads via SQLite until C3
2. **Prerequisite** — must run `context-chain index <root>` before first MCP use
3. **Claude Code setup** — `~/.claude/settings.json` example with `mcp.servers.context-chain.command`, `args`, optional `env`
4. **Permission modes** —
   - `permissions.allow: ["mcp__context-chain__record_decision"]` — Claude writes autonomously
   - `permissions.ask: [...]` — every write prompts the user
   Explicit: the choice is the user's Claude Code setting, not a flag in this tool.
5. **Error behavior** — validation failures come back in tool response; unexpected errors kill the tool
6. **Session ID** — env var `CONTEXT_CHAIN_SESSION_ID` if Claude Code injects one; otherwise null. The field is recorded but has no reader in v1.

## Out of scope

- Read tools (`list_decisions`, `get_callers`, etc.) — C3
- CLI fallback (`context-chain decide "..."`) — shell escaping is fragile, MCP already solves it
- Process pool / multi-project concurrency — one server per project
- Auto-detect project root by walking up to `.ctx/` — explicit CLI arg
- Dry-run / preview — handled by Claude Code's `permissions.ask` mode
- `session_id` consumption logic — it's a stored field with no query in v1

## Size budgets

- `src/mcp.ts` < 120
- `verify-mcp.ts` < 120
- `doc/mcp.md` ~ 100

## Implementation order

1. `npm install @modelcontextprotocol/sdk`
2. Write `src/mcp.ts` (types → `DecisionValidationError` → `validateArgs` → `handleRecordDecision` → MCP server setup → `main`)
3. Write `verify-mcp.ts` with 9 scenarios
4. Update `package.json` verify script
5. `npx tsc` — clean
6. `node dist/verify-mcp.js` — OK
7. `npm run verify` — all six green
8. Write `doc/mcp.md`
9. `wc -l` — check budgets

## Failure signals

- `src/mcp.ts` exceeds 120: probably too much in `main` — split server setup into a helper
- `validateArgs` exceeds 25 lines: too many cases in one function — consider extracting per-anchor validation
- MCP SDK version pins to a specific breaking version unexpectedly: lock via `package-lock.json`, document the version in `doc/mcp.md`
- Any verify scenario fails: fix the code, never the assertion

## Verification

```bash
npm install
npx tsc
npm run verify           # six verifies green
wc -l src/mcp.ts verify-mcp.ts

# manual smoke
node dist/src/mcp.js /tmp/nonexistent   # exits 1 with "no index at ..." message
context-chain index /tmp/some-indexed-project
node dist/src/mcp.js /tmp/some-indexed-project   # stays up, serves stdio
```

## Notes from implementation: batching

After the single-decision version shipped and verified, the tool was re-shaped to take a **batch** of decisions in one call. Real usage patterns surfaced 2–3 decisions at once at the end of a conversation, and forcing Claude to call the tool repeatedly wasted a full LLM turn per decision.

### Shape change

- Tool renamed: `record_decision` → `record_decisions`
- Top-level input: `{ decisions: [ { summary, context?, anchors } , ... ] }` — non-empty array, no upper bound
- Return value: `recorded N decisions: id1, id2, ...`

### Validation change: accumulate errors

The original design threw on the first validation failure. For a batch, this causes round-trip thrash: Claude fixes decision[1].summary, retries, then hears about decision[3].anchors[0].name, retries, then about decision[4].anchors being empty, retries. Each round is a full LLM turn.

The new validator accumulates errors across all decisions and all anchors, then returns them joined with `; `. Claude sees every problem at once and can fix them in a single retry.

Implementation: three functions (`validateAnchor`, `validateDecision`, `validateRecordArgs`), each returning `{ value?, errors: string[] }` or `ValidateResult<T>`. None of them `throw`; each pushes into a shared errors array and keeps inspecting whatever structure remains parseable. Only the top-level `handleRecordDecisions` throws a single `DecisionValidationError` with all collected errors joined into the message.

Error messages carry full JSON path prefixes (`decisions[0].anchors[1].kind must be 'function' or 'file'`), so Claude can map each error to its location in the original request.

### Atomicity

Validation happens entirely before any writes. If any decision in the batch is invalid, the whole batch is rejected — even the valid ones. `handleRecordDecisions` wraps all `createDecision` calls in a single outer `db.transaction`; better-sqlite3 supports nested transactions via savepoints, so the existing per-decision transaction inside `createDecision` composes correctly.

Partial success was considered and rejected. The recovery story for Claude is much simpler when the state is "all-or-nothing" — after an error, nothing was written, so the next retry is straightforward. Partial writes would leave Claude guessing "which of the 4 I sent actually landed".

### No max-batch-size limit

The earlier draft had `maxItems: 20` as a safety rail. User direction was to remove it: real decisions rarely exceed 3–5 per turn, and a hypothetical Claude failure that tried to send 1000 would produce validation errors faster than memory pressure. The limit costs a schema hint that would misleadingly cap legitimate use. No limit ships.

### Verify scenarios updated

The 9 original scenarios were restructured (args wrapped in `{decisions: [...]}`), and two new ones were added:

- **Batch happy path** (scenario 10): 3 decisions in one call, each with different anchors, return format asserted, all three retrievable by their respective anchors.
- **Multi-error accumulation + atomic rollback** (scenario 11): 4 decisions where positions 0/1/3 have different validation errors and position 2 is valid. Assertions:
  - single `DecisionValidationError` thrown
  - message contains the error prefixes for 0, 1, and 3
  - message does **not** contain `decisions[2]` (valid decision isn't accused)
  - row count in `decisions` table unchanged after the throw
  - the valid decision's summary cannot be found in the db

Scenario 11 is the critical proof that accumulation + atomicity both hold.

### Size after batching

- `src/mcp.ts`: 189 lines (was 155; three validators + `joinErrors` helper + `HandleResult` union)
- `verify-mcp.ts`: 205 lines (was 146; scenarios restructured + three new: batch happy, multi-error accumulation, non-object args, error cap)
- `doc/mcp.md`: 162 lines (was 140; schema example and error section updated)

`verify-mcp.ts` passes 200 slightly. Each scenario is load-bearing (particularly the multi-error proof); trimming would lose semantic fidelity. Not split.

### Second revision: error style + result-type contract

After the first batching ship, review surfaced four refinements:

1. **`\n` separator, not `; `** — a 5-error message as a single semicolon-joined line is ~140 chars Claude has to scan; newline-joined it's a readable list. Tool response text renders `\n` as line breaks in the Claude-visible prompt. Zero migration cost on assertions (`includes(...)` behaves identically).

2. **`handleRecordDecisions` returns `HandleResult`, not `throw`** — earlier design let the handler throw `DecisionValidationError`, caught by the MCP wrapper with a `try/catch`. That catch is the "try/catch that selectively rethrows" shape CLAUDE.md warns against. Replacing with a `{ ok, message }` discriminated union makes the wrapper two lines and zero `try/catch`. DB errors still bubble naturally via `createDecision` because the handler doesn't catch anything. `DecisionValidationError` class removed — unused.

3. **Scenario 11 renamed** — original title claimed "atomic rollback", but the path exercised is "validator fails upfront → nothing ever enters `db.transaction`". True nested-transaction rollback (validator passes, one `createDecision` then fails inside the outer transaction) is guarded by the schema CHECK constraint plus `validateAnchor`'s kind/name invariant. Both would have to diverge simultaneously to hit that path. Not separately tested — documented as "low-risk untested path; a CHECK violation at that point would indicate simultaneous validator and schema bugs". Scenario renamed to "Multi-error accumulation + no write on validation fail".

4. **Error accumulation capped at 50 lines** — `validateRecordArgs` runs unbounded, but `joinErrors` slices to the first 50 entries with a `... and N more` suffix. A hostile 10k-decision batch can't produce a 10k-line tool response that inflates context. Cap is a soft safety rail, not a correctness boundary.

Two scenarios added:

- **Scenario 12 (non-object args)**: loops over `null`, a string, a number, and an array; each must produce `arguments must be an object`.
- **Scenario 13 (error cap)**: 60 broken decisions produce ≤ 51 lines of output and include the `... and N more` marker.

Scenario 11's assertions updated to verify the separator is `\n` (explicit check that the message contains a newline).

### Sizes after second revision

Same as above (189 / 205 / 162). The net line change was small — removing the class and try/catch balanced adding the cap, the new result type, and two new scenarios.
