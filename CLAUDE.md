# Working Principles

This document is the contract for how we work. When I break a rule, cite it back at me.

## Code cleanliness

**Every line earns its place.** No "just in case" parameters. No helpers used once. No `util/`, `common/`, or `shared/` dumping grounds.

**Two-minute rule.** A new reader understands any single file in two minutes. Files under 100 lines; over 200 means the file does too much. Functions under 20 lines with early returns.

**Deletion-friendly.** Removing any piece is easy because dependencies are explicit. No re-export barrel files — callers import the source directly.

**High bar for abstraction.** One use case: never abstract. Two: usually still duplicate. Three: consider it, but often still duplicate. "Extensibility" is not a reason.

**Classes only for state.** A registry holding a Map is a class. A pure resolver is a function.

**Names carry meaning.** Files are nouns, functions are verbs. Avoid `Service`, `Manager`, `Handler`, `Processor` suffixes. Avoid `do`, `handle`, `process` verbs. No comments to compensate for bad names.

## Collaboration

**No unilateral decisions.** Schema fields, default values, directory structure — if you wouldn't immediately see why, ask first. When copying from another project, mark what is theirs versus what I am adding.

**Acknowledge design holes upfront.** Cross-file edge loss in incremental indexing, unique-key collisions, silent fallbacks, error recovery granularity, concurrency model — list these before you hit them.

**Honest verification.** "Verified" comes with what was tested and what was not. Numbers copied from another project (like confidence 0.95) are stated as copied, not validated.

**No unrequested features.** Implement exactly what was asked. Do not smuggle in improvements.

## Code style

- TypeScript strict mode.
- Zero comments by default. Comment only when "why" is non-obvious.
- No emoji in code or docs.
- Validate only at system boundaries. Trust internal code.
- Silent fallbacks are forbidden. If FTS5 is missing, throw; do not degrade to LIKE.
- No `try/catch` that rethrows. Let exceptions bubble.

## Communication

- Answer the question first, context after.
- Say "I do not know" when I do not.
- Tradeoffs, not just benefits, when recommending.
- Response length matches question complexity.
- Chinese questions get Chinese answers. Technical terms stay in English.

## Project

**Goal:** Lightweight code knowledge graph. tree-sitter + SQLite. `npm install` to use.

**Reference:** [codebase-memory](https://github.com/DeusData/codebase-memory-mcp) (MIT, C). We rewrite the core in TypeScript.

**Differentiator:** Decision capture via Claude Code hooks. Function-level anchoring, structured, queryable. Codebase-memory does not do this.

### Out of scope

- Decision relationship graphs (`CAUSED_BY`, `DEPENDS_ON`, `CONFLICTS_WITH`).
- Vector search and semantic similarity.
- Languages beyond TypeScript and JavaScript.
- Dashboard.
- Type inference and data flow analysis.

## Anti-patterns we're avoiding

- A 5000-line `server.ts` routing every endpoint.
- Multiple parallel pipelines that almost do the same thing.
- A decision model so complex the author stopped understanding it.
- Heuristics claimed as solved but silently falling back to the LLM.
