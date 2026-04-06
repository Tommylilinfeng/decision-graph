# Context Chain

A local knowledge graph that extracts design decisions from your codebase, serves them to your coding AI via MCP, and bridges the context window gap among teammates.

Existing context engineering tools (OpenSpec, Git-AI, Dexicon) capture knowledge at the spec or repo level. Context Chain goes deeper:

- **Function-level anchoring** — decisions are tied to specific functions via Joern CPG, not floating above the repo
- **Automatic staleness detection** — code changes flag affected decisions; knowledge doesn't silently rot
- **Decision-level extraction** — not prompt summaries or raw transcripts, but _what was chosen, what was rejected, and why_
- **Decision relationships** — `CAUSED_BY`, `DEPENDS_ON`, `CONFLICTS_WITH` edges across a graph, not flat files
- **Runs overnight on your subscription** — uses `claude -p` or `codex exec` (Claude CLI / Codex CLI), no API costs, doesn't eat your daytime quota

```
Codebase → Noise Filter → Module Discovery (LLM + IQR + Import Analysis)
    → Sub-Module Discovery (file-level treemap grouping)
        → Doc Generation (source-level, per sub-module → module synthesis)
            → Scenario Tracing (graph BFS + LLM narrative)
                → Memgraph (graph DB) → MCP Server + Dashboard
                    → 3D Architecture Map + Scenario Walkthrough
```

> **System requirements:** Context Chain relies on **Memgraph** (graph database, ~1.5 GB) and **Joern** (code analysis, ~2 GB) — expect **~3.5 GB+ disk space** and Docker installed. This is a relatively heavy local tool, not a lightweight plugin.

**Website:** [usecontextchain.com](https://usecontextchain.com)

---

## Roadmap

| Area | What's coming |
|------|--------------|
| Consumption layer | Immersive KT system and team knowledge map — help _people_ understand the codebase, not just AI |
| Agent support | Currently Claude Code; adding Cursor, Windsurf, Cline, Copilot, and other MCP-compatible agents |
| Multi-source ingestion | Slack threads, Notion docs, meeting transcripts — not just code and AI sessions |
| Spec-driven workflow | OpenSpec-style proposal → spec → design → implement, with decisions auto-anchored after implementation |

---

## Quick Start

```bash
# Prerequisites: Node.js 18+, Docker, Claude CLI
# (Java and Joern are auto-installed by setup if missing)
git clone https://github.com/Tommylilinfeng/context-chain.git
cd context-chain && npm run setup
```

```bash
# Start Memgraph (wait for it to be ready before proceeding)
docker compose up -d
```

```bash
# Start the Dashboard
npm run dashboard
# → http://localhost:3001
```

From the Dashboard:

1. **System** → Add your repo (name, path, language)
2. **System** → Generate CPG (Joern code analysis)
3. **System** → Full Setup (schema + import code structure)
4. **Design** → Discover Modules → Run sub-module decomposition
5. **Exploded Map** → 3D architecture visualization with scenario tracing
6. **Run** → Execute analysis → decisions appear, then **Group** to connect them

Or from CLI:

```bash
npm run db:schema                                         # init schema
npm run ingest:cpg -- --file data/your-repo.json          # import code structure
npm run analyze -- --repo my-repo                         # full scan (Ctrl+C to pause, --continue to resume)
npm run mcp                                               # start MCP server
```

### Connect to Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "context-chain": {
      "command": "/bin/bash",
      "args": ["/path/to/context-chain/mcp-start.sh"]
    }
  }
}
```

Or use the install script: `bash scripts/install-hooks.sh /path/to/your/project`

Now when Claude Code works on your codebase, it can query "why was this written this way?" and get real answers.

---

## What gets extracted

Not descriptions of what code does (any AI can read source for that) — but **decisions**: what was chosen, what was rejected, why, and what tradeoffs were accepted. Each decision is anchored to specific functions and linked to related decisions. When your coding AI later touches that function, relevant decisions surface automatically via MCP.

---

## Five-slot retrieval

When your coding AI asks for context, Context Chain searches five channels in priority order:

1. **Code anchor** — exact function/file match in the graph
2. **Keywords** — inverted index match (business terms like "refund", "auth" that don't exist in code)
3. **Decision relationships** — one-hop expansion along CAUSED_BY / DEPENDS_ON / CONFLICTS_WITH edges
4. **Semantic similarity** — vector search fallback (catches "idempotency" when you searched "prevent duplicate charges")
5. **Metadata filters** — staleness, recency, owner — applied on top of all results

Progressive disclosure: summaries first, full content on demand.

---

## Core architecture

### analyze_function — the building block

All decision extraction goes through one module: give it a function name + config, it queries the graph for callers/callees, reads source code, calls the LLM, and outputs structured decisions.

Highly configurable via a template system (JSON files with inheritance):

```bash
npm run analyze -- --list-templates                           # see available templates
npm run analyze -- --function createOrder --file store/orderStore.js --repo my-repo
npm run analyze -- --repo my-repo --template deep-analysis    # full scan with a specific template
npm run analyze -- --repo my-repo --continue                  # resume interrupted scan
```

Configuration dimensions: context depth (caller/callee hops), code granularity (full/truncated/signature), output control (finding types, max decisions, language), prompt templates, AI provider.

### Cluster Analysis

When running bulk analysis with batch size > 1, Cluster Analysis groups related functions by their CALLS edges in the graph rather than processing them in arbitrary order.

**How it works:**
1. **Greedy set cover** selects center functions that maximize coverage of the call graph
2. Each center + its direct callers/callees become one batch (targets)
3. Second-level callers/callees are loaded as context-only (not analyzed, but visible to the LLM)
4. Shared context is deduplicated — if two targets share a caller, its code appears once in the prompt
5. Existing decisions for already-analyzed functions are fed as context
6. Orphan functions with no CALLS edges fall back to linear batching

**Benefits:** 30-50% token savings on tightly-coupled modules. The LLM sees related functions together, producing more coherent cross-function decisions and fewer contradictions. Context window overflow is handled automatically by trimming batches.

Enable in Dashboard: **Run** → toggle **Cluster Analysis** on.

### Module Discovery

Automatically discovers the architectural module structure of a codebase using export analysis — no graph algorithms or CALLS edges needed.

**How it works (4-phase pipeline, ~25K tokens total):**
1. **Export Scan** — extract export names from all TS/TSX/JS files, group by directory (zero LLM cost)
2. **LLM Chunk + Merge** — split directories into N chunks, N concurrent LLM calls identify subsystems, then 1 merge call deduplicates into 12-20 modules
3. **IQR Outlier Split** — statistical outlier detection (Tukey's IQR method) flags oversized modules. LLM splits them — unless they're cross-cutting foundation layers, which are kept as-is
4. **Import Backfill** — orphan files in flat directories (like `utils/`) are assigned by import analysis: files imported by exactly 1 external module go to that module; files imported by 0 or 2+ modules go to a Foundation module

**Key design decisions:**
- Export names are the richest zero-cost signal — a file's public API reveals its architectural role without reading function bodies
- IQR outlier detection is project-agnostic — adapts without hardcoded thresholds
- Foundation modules are kept large intentionally — per DDD's "Shared Kernel" pattern, cross-cutting infrastructure belongs in a dedicated layer

Now includes a **noise filter** pre-step that marks parser artifacts (`:program`) and trivial isolated functions before module assignment. Exclusive directory matching ensures no function belongs to multiple modules.

**Output:** `SemanticModule` nodes in the graph with `BELONGS_TO` edges.

```bash
npm run discover-modules -- --repo my-repo              # full run (includes noise filter)
npm run discover-modules -- --repo my-repo --dry-run    # preview without writing to graph
```

Tested on Claude Code (1,902 files): 39 modules, 10,445 signal functions (3,447 noise filtered), 100% coverage, ~24K tokens, ~215s.

### Sub-Module Discovery

File-level architecture discovery within each module — same philosophy as module discovery (exports as signal, files as unit), applied recursively.

**Pipeline (per module, 1-3 LLM calls):**
1. **File Export Scan** — get all files belonging to module from graph, scan exports
2. **LLM Chunk + Merge** — for large modules (100+ files), chunk files and merge sub-module candidates
3. **LLM Assign** — assign every file to exactly one sub-module. Cohesive modules auto-promoted as single sub-module (no LLM needed)

```bash
npx ts-node src/runners/run-all-submodules.ts           # all modules
npx ts-node src/runners/test-submodules.ts              # test on foundation + tool_framework
```

Tested on Claude Code: **262 sub-modules** across 39 modules, 100% coverage, 113K tokens, ~27 min. Zero Other/Unclassified.

**Output:** `SubModule` nodes with `CHILD_OF` → `SemanticModule` and `BELONGS_TO` edges.

### Documentation Generation

Two-tier source-level doc generation: full source code feeds per-sub-module analysis, then module-level synthesis.

**Pipeline:**
1. **Per sub-module** — read all source files, 1 LLM call → deep technical doc with design decisions from code + comments
2. **Per module synthesis** — sub-module docs + importance signals (external caller count) → unified module guide. Organizes by concepts, not sub-module boundaries. Core sub-modules get 80% of coverage.

```bash
npx ts-node src/runners/generate-docs.ts --repo my-repo --module tool_framework
npx ts-node src/runners/generate-docs.ts --repo my-repo --module foundation --module memory_system
```

### Scenario Discovery & Visualization

Cross-module execution path tracing with interactive 3D architecture map.

**Scenario tracing:**
- Graph BFS from entry point functions, 3-hop depth, cross-module edges only
- Caller-grouped steps (fan-out pattern): "A calls B, C, D" as one step
- LLM narrative generation guided by user prompts + sub-module docs

**Architecture map** (`/architecture-map` on dashboard):
- Isometric 3D exploded view: per-module boards with treemap-packed sub-module chips
- Shift+drag rotation, scroll zoom, click-to-inspect detail panel
- Scenario overlay: select entry point or type a question → involved sub-modules highlight, animated flow lines between layers
- Balanced layout: weighted centroid algorithm centers large modules

```bash
npx ts-node src/runners/test-scenarios.ts --entry checkPermissionsAndCallTool
npm run dashboard  # → http://localhost:3001/architecture-map
```

### MCP Server

Single tool: `get_context_for_code` — five-channel fused retrieval (anchor, keyword, relationship, vector). Supports summary/detail modes and single-decision expansion with relationship chains.

### Dashboard

Web UI for browsing decisions, visualizing coverage gaps, managing pipelines, and configuring repos. Supports EN/ZH.

```bash
npm run dashboard    # http://localhost:3001
```

### Concern Analysis

Groups decisions into concerns — cohesive areas of design reasoning (e.g. "authentication strategy", "order lifecycle management"). Uses LLM-guided clustering: all decision summaries are sent to the LLM in a single pass to group by design intent, then each concern is analyzed for architectural layers, risks, and cross-concern dependencies. Available in the Dashboard under **Concerns**.

### Refinement pipeline

Runs overnight to keep the graph accurate:

```bash
npm run refine                       # all tasks
npm run refine -- --only staleness   # single task
```

Tasks: staleness detection (compare against git HEAD), anchor precision upgrade, keyword normalization, decision edge completion, gap detection (high-complexity functions with zero coverage).

---

## Configuration

`ckg.config.json` in project root (see `ckg.config.example.json`):

```json
{
  "project": "my-project",
  "ai": { "provider": "claude-cli" },
  "repos": [
    {
      "name": "my-service",
      "path": "/absolute/path/to/repo",
      "type": "backend",
      "cpgFile": "data/my-service.json"
    }
  ]
}
```

AI providers: `claude-cli` (Anthropic subscription), `codex-cli` (OpenAI subscription), or `anthropic-api` (direct API key). Set in config or Dashboard.

---

## Data model

### Node types

```
CodeEntity        — Code structure: service / file / function / api_endpoint
DecisionContext   — Design decision: why, tradeoffs, rejected alternatives
SemanticModule    — Discovered module: name, description, confidence
SubModule         — Sub-module within a semantic module (from design analysis)
AggregatedSummary — Aggregated summary (generated by refinement)
```

### Edge types

```
# Code structure (from Joern / LLM)
CONTAINS          — service -> file -> function
CALLS             — function calls function
CALLS_CROSS_REPO  — cross-repo function call
DEPENDS_ON_API    — cross-service API dependency
ACCESSES_TABLE    — function accesses database table

# Decision anchoring
ANCHORED_TO       — DecisionContext -> CodeEntity (precise)
APPROXIMATE_TO    — DecisionContext -> CodeEntity (fuzzy)

# Module membership (many-to-many)
BELONGS_TO        — function -> SemanticModule (or SubModule)
CHILD_OF          — SubModule -> SemanticModule

# Decision relationships
CAUSED_BY         — decision A exists because of decision B
DEPENDS_ON        — decision A requires decision B
CONFLICTS_WITH    — decisions A and B have tension/tradeoff
CO_DECIDED        — made together in the same decision session
SUPERSEDES        — new decision replaces old decision
```

---

## Tech stack

| Component | Technology |
|-----------|-----------|
| Graph DB | Memgraph |
| Code analysis | Joern (CPG) |
| Decision extraction | Claude CLI / Codex CLI / Anthropic API |
| Embedding | Voyage AI (optional) |
| MCP Server | TypeScript + `@modelcontextprotocol/sdk` |
| Dashboard | Hono + vanilla HTML/JS |
| Container | Docker Compose |

---

## All commands

```bash
# Infrastructure
docker compose up -d               # Start Memgraph
npm run db:schema                  # Initialize schema
npm run db:reset                   # Clear entire graph

# Core — analyze_function
npm run analyze -- --list-templates                     # List templates
npm run analyze -- --function X --file Y --repo Z       # Single function
npm run analyze -- --repo Z                             # Full scan
npm run analyze -- --repo Z --continue                  # Resume from checkpoint

# Code structure
npm run ingest:cpg -- --file X     # Import CPG
npm run link:repos                 # Cross-repo calls
npm run link:services              # Cross-service dependencies
npm run link:tables                # Table access relationships

# Pipelines
npm run analyze -- --repo X        # Full-scan function analysis
npm run ingest:sessions:v2         # Session ingestion

# Module Discovery
npm run discover-modules -- --repo X          # Export-based architecture discovery
npm run discover-modules -- --repo X --dry-run        # Preview without writing to graph

# Design Analysis
npm run design-analysis -- --repo X --stats               # Module stats + token estimates (no LLM)
npm run design-analysis -- --repo X --backfill             # Backfill orphan functions (no LLM)
npm run design-analysis -- --repo X --max-lines 10         # Sub-module decomposition
npm run design-analysis -- --repo X --limit 2 --dry-run    # Test on 2 modules

# Refinement
npm run refine                     # All 5 refinement tasks
npm run embed:decisions            # Generate embeddings

# Services
npm run mcp                        # MCP Server
npm run dashboard                  # Dashboard (localhost:3001)
```

---

## Status

Core pipeline (analyze_function + full-scan runner + MCP Server + Dashboard + session ingestion + Joern CPG + cross-repo linking) is production-tested on a multi-repo TypeScript project. Semantic module discovery and design analysis (sub-module decomposition) are code-complete with dashboard integration. Semantic vector search and refinement pipeline are code-complete.

---

## License

Apache-2.0
