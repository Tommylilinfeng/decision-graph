# context-chain

Lightweight code knowledge graph for TypeScript / JavaScript, with design-decision capture via Claude Code hooks. Tree-sitter + SQLite, no LLM calls at runtime.

## Install

```bash
git clone <repo> context-chain
cd context-chain
npm install       # auto-builds via the prepare hook
npm link          # or: npm install -g .
npm run verify    # optional — runs seven verify scripts, all should print OK
```

## Usage

### Index a project

```bash
cd /path/to/your/ts-project
context-chain index .
context-chain stats
```

Creates `.ctx/graph.db` at the project root. Re-running `index` rebuilds fully (no incremental in v1).

### Claude Code integration

Copy `.mcp.json.example` to a project as `.mcp.json` (Claude Code picks it up automatically when you open that project), or merge the hooks + MCP block into `~/.claude/settings.json` for a user-wide setup. Both absolute paths — the `dist/src/mcp.js` binary and the project you indexed — must be edited.

Full hook list, output format, and flow walkthrough: `doc/consumption.md`.

MCP exposes three tools (`record_decisions`, `decisions_by_keyword`, `reset_decision_cache`). Each tool's description is self-explanatory in-client; see `doc/mcp.md` for background.

## Architecture

Seven layers. Each has a plan doc under `doc/plan-*.md` with scope, decisions, and verify scenarios:

```
storage → extract → resolve → pipeline → decisions → mcp → consumption
```

Working principles: `CLAUDE.md`.

## v1 scope

- TypeScript / JavaScript only
- Full rebuild per `index` run
- Call resolution: named imports + same-module only. Member chains (`obj.method()`), default / namespace imports, and barrel re-exports are explicitly unresolved — see `doc/plan-resolve.md`
- Decisions are *alerts* for what grep cannot find — not documentation, TODOs, or bug notes

## License

Apache-2.0
