# Context Chain

> **grep finds what code does. We record why it was written that way.**

---

## What is this

When developers work with AI, conversations contain critical design decisions — why approach A was chosen over B, what tradeoffs were made, what alternatives were considered. But these insights vanish when the chat window closes.

Context Chain automatically extracts design decisions from your codebase, stores them as a knowledge graph, and serves them to Claude Code / Cursor via MCP.

**Core architecture (3 layers):**

1. **Graph layer** — Memgraph stores code entities, decisions, and relationships. Five-slot retrieval model for precise context lookup.
2. **Building block layer** — `analyze_function`: input a function + config, query graph for context, read source code, call AI, output decisions. Highly configurable via templates.
3. **Runner layer** — Orchestrates building block execution. Built-in full-scan runner (pause/resume), cold-start pipeline (4-round goal-driven), and Quick Scan (zero-config one-click).

---

## Getting Started

### Prerequisites

- **Node.js** v18+
- **Docker** (for Memgraph)
- **Joern** — code structure analysis (`brew install joern` on macOS)
- **Claude CLI** or **Anthropic API key** — for AI-powered analysis

```bash
# Install Claude CLI (if using subscription)
npm install -g @anthropic-ai/claude-code
claude login

# Or use Anthropic API instead — configure in the Dashboard
```

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Start Memgraph
docker compose up -d

# 3. Start the Dashboard
npm run dashboard
# Open http://localhost:3001
```

### First Run (Dashboard)

1. Go to **System** page — add your repos (name, path, type)
2. Generate CPG files with Joern for each repo
3. Click **Full Setup** on the System page (schema + ingest + link)
4. Go to **Quick Scan** — select a repo, click Scan
5. Design decisions appear automatically — no goal or business context needed

### First Run (CLI)

```bash
# 1. Initialize schema
npm run db:schema

# 2. Import code structure (requires Joern CPG)
npm run ingest:cpg -- --file data/your-repo.json

# 3. Try analyzing a single function
npm run analyze -- --function createOrder --file store/orderStore.js --repo my-repo

# 4. Full scan (Ctrl+C to pause, --continue to resume)
npm run analyze -- --repo my-repo --cleanup

# 5. Start MCP Server (Claude Code / Cursor auto-connects)
npm run mcp
```

---

## Configuration

Create `ckg.config.json` in the project root (see `ckg.config.example.json`):

```json
{
  "project": "my-project",
  "ai": {
    "provider": "claude-cli"
  },
  "repos": [
    {
      "name": "my-service",
      "path": "/absolute/path/to/repo",
      "type": "backend",
      "cpgFile": "data/my-service.json",
      "packages": []
    }
  ]
}
```

**AI providers:**
- `claude-cli` — Uses Claude CLI subscription (no API cost). Requires `claude login`.
- `anthropic-api` — Direct API calls. Set `apiKey` in config or Dashboard.

---

## analyze_function — Core Building Block

All decision extraction goes through this module. Highly configurable:

### Configuration

| Dimension | Options |
|-----------|---------|
| Context depth | `caller_depth` (0-2), `callee_depth` (0-2), `include_cross_repo`, `include_table_access` |
| Code granularity | `target_code` (full/truncated/signature_only), `target_max_lines`, `include_file_context` |
| Output control | `finding_types` (decision/suboptimal/bug), `max_decisions`, `summary_length`, `language` |
| Prompt | `prompt_template`, `system_prompt`, `custom_context` |
| AI | `ai_provider`, `model`, `timeout_ms` |

### Template System

Templates are JSON files with inheritance:

```
templates/
  _default.json           <- built-in defaults
  quick-scan.json         <- extends _default, overrides specific fields
  deep-analysis.json
  your-custom.json
```

```json
{
  "name": "Quick Scan",
  "extends": "_default",
  "caller_depth": 0,
  "callee_depth": 0,
  "finding_types": ["decision"],
  "max_decisions": 2
}
```

### CLI Usage

```bash
# List available templates
npm run analyze -- --list-templates

# Single function analysis
npm run analyze -- --function addItem --file store/cartStore.js --repo my-repo

# With specific template
npm run analyze -- --function addItem --file store/cartStore.js --repo my-repo --template deep-analysis

# Full scan (all functions in a repo)
npm run analyze -- --repo my-repo
npm run analyze -- --repo my-repo --continue      # resume from checkpoint
npm run analyze -- --repo my-repo --force --cleanup  # force re-analyze + cleanup

# Budget control
npm run analyze -- --repo my-repo --budget 500000

# CLI config overrides
npm run analyze -- --repo my-repo --caller-depth 2 --include-tables --language en
```

### As a Library

```typescript
import { analyzeFunction, loadTemplate } from './core'

const result = await analyzeFunction(
  { functionName: 'createOrder', filePath: 'store/orderStore.js', repo: 'my-repo', repoPath: '/path/to/repo' },
  { caller_depth: 2, include_table_access: true },
  'deep-analysis'
)
// result.decisions — PendingDecisionOutput[]
// result.metadata — { template_used, caller_count, callee_count, token_usage, duration_ms }
```

---

## MCP Server — 9 Tools

| Tool | Description |
|------|-------------|
| `get_code_structure` | List functions/services in a file |
| `get_callers` | Who calls this function (upstream) |
| `get_callees` | What this function calls (downstream) |
| `search_decisions_by_keyword` | Keyword search with inverted index + full-text fallback |
| `get_context_for_code` | Five-slot retrieval with progressive disclosure |
| `search_decisions_semantic` | Vector similarity search (requires embedding provider) |
| `get_decision_relationships` | Explore causal/dependency/conflict chains |
| `get_cross_repo_dependencies` | Cross-repo and cross-service dependencies |
| `report_context_usage` | Feedback loop: which decisions were actually used |

### Five-Slot Retrieval

`get_context_for_code` queries five channels in priority order:

1. **P0 Exact anchor** — function-level ANCHORED_TO match
2. **P1 Fuzzy anchor** — file-level APPROXIMATE_TO match
3. **P2 Keywords** — keyword array CONTAINS match
4. **P3 Relationship expansion** — one-hop CAUSED_BY/DEPENDS_ON/CONFLICTS_WITH from P0-P2 hits
5. **P4 Semantic fallback** — vector similarity (requires embedding config)

Progressive disclosure: returns summary list by default, `detail=true` for full content, `decision_id` for single decision + 2-hop chain.

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

---

## Dashboard

```bash
npm run dashboard    # http://localhost:3001
```

| Page | Description |
|------|-------------|
| **Overview** | Stats, repo coverage, keyword cloud, recent decisions |
| **Decisions** | Browse + search + filter decisions by type/repo |
| **Relationships** | Decision relationship graph visualization |
| **Coverage** | File/function-level decision coverage |
| **Dependencies** | Cross-repo dependency force graph |
| **Feedback** | Usage log — which decisions are being used |
| **Sessions** | Ingest decisions from AI coding sessions |
| **Templates** | Visual editor for analyze_function configs |
| **Pipeline** | Prompt template editor for cold-start pipeline |
| **Run / Schedule** | One-click pipeline execution + cron scheduling |
| **Quick Scan** | Select a repo, get decisions instantly — no goal needed |
| **Getting Started** | Step-by-step onboarding with live status checks |
| **Query** | Execute raw Cypher queries |
| **System** | Memgraph status, repo config, AI provider, setup actions |

---

## Refinement Pipeline

```bash
npm run refine                          # all 5 tasks
npm run refine -- --only staleness      # single task
npm run refine -- --budget 200000       # with token budget
```

5 tasks:

1. **Staleness detection** — compare against git HEAD, mark changed decisions as stale
2. **Anchor precision upgrade** — APPROXIMATE_TO to ANCHORED_TO (when summary contains function name)
3. **Keyword normalization** — LLM merges synonyms into canonical forms
4. **Decision edge completion** — analyze same-file decision pairs for CAUSED_BY / DEPENDS_ON / CONFLICTS_WITH
5. **Gap detection** — find high-call-count functions with zero decision coverage

---

## Data Model

### Node Types

```
CodeEntity        — Code structure: service / file / function / api_endpoint
DecisionContext   — Design decision: why, tradeoffs, rejected alternatives
AggregatedSummary — Aggregated summary (generated by refinement)
```

### Edge Types

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

# Decision relationships
CAUSED_BY         — decision A exists because of decision B
DEPENDS_ON        — decision A requires decision B
CONFLICTS_WITH    — decisions A and B have tension/tradeoff
CO_DECIDED        — made together in the same decision session
SUPERSEDES        — new decision replaces old decision
```

---

## Tech Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Graph DB | Memgraph | Code structure + decision nodes + relationships |
| Visualization | Memgraph Lab | Graph browser (`localhost:3000`) |
| Code Analysis | Joern | CPG generation (function calls, data flow) |
| Decision Extraction | Claude CLI / Anthropic API | Core AI calls |
| Embedding | Voyage AI | Semantic vector search (optional) |
| MCP Server | TypeScript + `@modelcontextprotocol/sdk` | 9 query/feedback tools |
| Dashboard | Hono + vanilla HTML/JS | Management UI (15 pages) |
| Container | Docker Compose | Memgraph + Lab |

---

## All Commands

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
npm run analyze -- --repo Z --force --cleanup           # Force re-analyze + cleanup

# Code structure
npm run ingest:cpg -- --file X     # Import CPG
npm run link:repos                 # Cross-repo calls
npm run link:services              # Cross-service dependencies
npm run link:tables                # Table access relationships

# Pipelines
npm run cold-start:v2 -- --goal X  # Cold-start 4-round pipeline
npm run ingest:sessions:v2         # Session ingestion

# Decision relationships
npm run connect                    # Normalize keywords + process PENDING edges
npm run connect -- --budget 200000 # With token budget

# Refinement
npm run refine                     # All 5 refinement tasks
npm run embed:decisions            # Generate embeddings

# Cleanup
npm run cleanup                    # Delete pipeline session files
npm run cleanup -- --dry-run       # Preview only

# Services
npm run mcp                        # MCP Server
npm run dashboard                  # Dashboard (localhost:3001)
```

---

## Project Structure

```
context-chain/
├── docker-compose.yml
├── ckg.config.json                 # Project config (repos, AI provider)
├── ckg.config.example.json         # Example config template
├── templates/                      # analyze_function templates
│   ├── _default.json
│   ├── quick-scan.json
│   └── deep-analysis.json
├── src/
│   ├── core/                       # Core building blocks
│   │   ├── analyze-function.ts     # Single function analysis
│   │   ├── template-loader.ts      # Template loading/inheritance
│   │   └── types.ts
│   ├── runners/                    # CLI runners
│   │   ├── analyze.ts              # Single function + full scan
│   │   ├── connect.ts              # Keyword normalization + relationship connection
│   │   └── cleanup-sessions.ts
│   ├── ai/                         # AI provider abstraction
│   │   ├── claude-cli.ts           # Claude CLI implementation
│   │   ├── anthropic-api.ts        # Anthropic API implementation
│   │   ├── embeddings.ts           # Voyage AI embedding
│   │   └── budget.ts               # Token budget management
│   ├── mcp/
│   │   └── server.ts               # MCP Server (9 tools)
│   ├── ingestion/                  # Data ingestion pipelines
│   │   ├── cold-start-v2.ts        # 4-round pipeline
│   │   ├── quick-scan.ts           # Zero-config scan (filesystem-based)
│   │   ├── ingest-sessions-v2.ts   # Session ingestion
│   │   ├── refine.ts               # Refinement (5 tasks)
│   │   ├── ingest-cpg.ts           # CPG -> Memgraph
│   │   ├── link-repos.ts           # Cross-repo call linking
│   │   └── ...
│   ├── db/                         # Memgraph connection/schema
│   └── dashboard/                  # Dashboard UI + API
│       ├── server.ts               # Hono API server
│       ├── public/shared.css       # Shared styles
│       ├── public/sidebar.js       # Sidebar + i18n
│       └── public/*.html           # 15 page files
├── data/                           # Runtime data (gitignored)
├── scripts/                        # Setup and utility scripts
└── joern/                          # Joern CPG extraction scripts
```

---

## Status

Working:
- analyze_function core module + template system
- Full-scan runner (pause/resume, dedup, budget, progress estimation)
- MCP Server (9 tools, five-slot retrieval + progressive disclosure + feedback loop)
- Refinement pipeline (5 tasks)
- Dashboard (15 pages, including template editor, Quick Scan, onboarding)
- Semantic vector search module (Voyage AI + local vector store)
- Session ingestion v2 (3-stage pipeline)
- Code structure layer (Joern CPG + SQL parsing + cross-repo/service/table linking)
- Pipeline session cleanup

Not yet tested in production:
- Semantic vector search (code complete, needs Voyage API key + embed:decisions run)
- Refinement pipeline (code complete, not yet run)
- Decision relationship edges (code complete, needs refine or cold-start Round 4)

---

## License

Apache-2.0
