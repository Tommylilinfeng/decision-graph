/**
 * ingestion/scenario-discovery.ts
 *
 * Hybrid scenario discovery: graph backbone + LLM narrative.
 *
 * Pipeline:
 *   1. Graph: extract cross-module call subgraphs from entry points
 *   2. Source: read key function bodies at branch/merge/loop points
 *   3. LLM: identify specific scenarios, narrate with branches/loops/merges
 */

import * as fs from 'fs'
import * as path from 'path'
import { Session } from 'neo4j-driver'
import { AIProvider } from '../ai/types'
import { toNum, runWithConcurrency } from './shared'
import { NOISE_FILTER } from './noise-filter'

// ── Types ──────────────────────────────────────────────

export interface ScenarioOpts {
  dbSession: Session
  ai: AIProvider
  repo: string
  repoPath: string
  outputDir: string
  entryPoints?: string[]  // function names; auto-detected if omitted
  maxEntryPoints?: number
  concurrency?: number
  onProgress?: (msg: string) => void
}

interface GraphNode {
  name: string
  file: string
  module: string
  subModule: string
  lineStart: number
  lineEnd: number
}

interface GraphEdge {
  from: string   // "file::name"
  to: string     // "file::name"
  crossModule: boolean
}

interface CallSubgraph {
  entryKey: string
  entry: GraphNode
  nodes: Map<string, GraphNode>
  edges: GraphEdge[]
  branches: string[]   // node keys with 2+ cross-module callees
  merges: string[]     // node keys with 2+ cross-module callers
  loops: string[][]    // cycles detected
}

// ── Graph Extraction ───────────────────────────────────

function nodeKey(file: string, name: string): string {
  return `${file}::${name}`
}

async function findEntryPoints(
  session: Session,
  repo: string,
  limit: number,
): Promise<{ name: string; file: string; moduleSpan: number }[]> {
  const res = await session.run(`
    MATCH (fn:CodeEntity {entity_type: 'function', repo: $repo})-[:CALLS]->(callee:CodeEntity {entity_type: 'function'})
    WHERE ${NOISE_FILTER}
    MATCH (fn)-[:BELONGS_TO]->(sm:SemanticModule)
    MATCH (callee)-[:BELONGS_TO]->(sm2:SemanticModule)
    WHERE sm.id <> sm2.id
    WITH fn, count(DISTINCT sm2) AS moduleSpan
    WHERE moduleSpan >= 3
    MATCH (f:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(fn)
    RETURN fn.name AS name, f.path AS file, moduleSpan
    ORDER BY moduleSpan DESC, fn.name
    LIMIT $limit
  `, { repo, limit })

  return res.records.map(r => ({
    name: r.get('name') as string,
    file: r.get('file') as string,
    moduleSpan: toNum(r.get('moduleSpan')),
  }))
}

async function extractSubgraph(
  session: Session,
  repo: string,
  entryName: string,
  entryFile: string,
  maxDepth: number = 3,
): Promise<CallSubgraph> {
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const visited = new Set<string>()
  const inDegree = new Map<string, Set<string>>()  // key → set of caller keys

  // BFS level by level
  let frontier = [{ name: entryName, file: entryFile }]

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: { name: string; file: string }[] = []

    for (const { name, file } of frontier) {
      const key = nodeKey(file, name)
      if (visited.has(key)) continue
      visited.add(key)

      // Get node metadata
      if (!nodes.has(key)) {
        const nodeRes = await session.run(`
          MATCH (fn:CodeEntity {entity_type: 'function', name: $name, repo: $repo})
          MATCH (f:CodeEntity {entity_type: 'file', path: $file})-[:CONTAINS]->(fn)
          OPTIONAL MATCH (fn)-[:BELONGS_TO]->(sm:SemanticModule)
          OPTIONAL MATCH (fn)-[:BELONGS_TO]->(sub:SubModule)
          RETURN fn.line_start AS ls, fn.line_end AS le, sm.name AS mod, sub.name AS sub
        `, { name, file, repo })
        if (nodeRes.records.length > 0) {
          const r = nodeRes.records[0]
          nodes.set(key, {
            name, file,
            module: (r.get('mod') as string) ?? '?',
            subModule: (r.get('sub') as string) ?? '?',
            lineStart: toNum(r.get('ls')),
            lineEnd: toNum(r.get('le')),
          })
        }
      }

      // Get callees (only cross-module or important same-module)
      const callRes = await session.run(`
        MATCH (fn:CodeEntity {entity_type: 'function', name: $name, repo: $repo})
        MATCH (f:CodeEntity {entity_type: 'file', path: $file})-[:CONTAINS]->(fn)
        MATCH (fn)-[:CALLS]->(callee:CodeEntity {entity_type: 'function'})
        WHERE ${NOISE_FILTER.replace(/fn\./g, 'callee.')}
        MATCH (cf:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(callee)
        OPTIONAL MATCH (fn)-[:BELONGS_TO]->(sm1:SemanticModule)
        OPTIONAL MATCH (callee)-[:BELONGS_TO]->(sm2:SemanticModule)
        RETURN callee.name AS calleeName, cf.path AS calleeFile,
               sm1.id AS fromMod, sm2.id AS toMod
      `, { name, file, repo })

      for (const cr of callRes.records) {
        const calleeName = cr.get('calleeName') as string
        const calleeFile = cr.get('calleeFile') as string
        const fromMod = cr.get('fromMod') as string
        const toMod = cr.get('toMod') as string
        const crossModule = fromMod !== toMod
        const calleeKey = nodeKey(calleeFile, calleeName)

        edges.push({ from: key, to: calleeKey, crossModule })

        // Track in-degree for merge detection
        if (!inDegree.has(calleeKey)) inDegree.set(calleeKey, new Set())
        inDegree.get(calleeKey)!.add(key)

        // Only follow cross-module edges deeper (keep graph focused)
        if (crossModule || depth === 0) {
          nextFrontier.push({ name: calleeName, file: calleeFile })
        }
      }
    }

    frontier = nextFrontier
  }

  // Detect branches: nodes with 2+ cross-module callees
  const outCrossModule = new Map<string, number>()
  for (const e of edges) {
    if (e.crossModule) {
      outCrossModule.set(e.from, (outCrossModule.get(e.from) ?? 0) + 1)
    }
  }
  const branches = Array.from(outCrossModule.entries())
    .filter(([, c]) => c >= 2)
    .map(([k]) => k)

  // Detect merges: nodes with 2+ cross-module callers
  const merges = Array.from(inDegree.entries())
    .filter(([, callers]) => {
      const callerMods = new Set<string>()
      for (const ck of callers) {
        const n = nodes.get(ck)
        if (n) callerMods.add(n.module)
      }
      return callerMods.size >= 2
    })
    .map(([k]) => k)

  // Detect loops: if any node was reached via a back-edge
  const loops: string[][] = []
  for (const e of edges) {
    if (e.from === e.to) continue
    // Simple loop detection: if we have A→B and B→A
    const reverse = edges.find(r => r.from === e.to && r.to === e.from)
    if (reverse) {
      const loop = [e.from, e.to].sort()
      if (!loops.some(l => l[0] === loop[0] && l[1] === loop[1])) {
        loops.push(loop)
      }
    }
  }

  const entryKey = nodeKey(entryFile, entryName)
  return { entryKey, entry: nodes.get(entryKey)!, nodes, edges, branches, merges, loops }
}

// ── Source Code Reading ─────────────────────────────────

function readFunctionSource(repoPath: string, file: string, lineStart: number, lineEnd: number, maxLines: number = 60): string | null {
  const abs = path.join(repoPath, file)
  try {
    const content = fs.readFileSync(abs, 'utf-8')
    const lines = content.split('\n')
    const start = Math.max(0, lineStart - 1)
    const end = Math.min(lines.length, lineEnd)
    const slice = lines.slice(start, Math.min(start + maxLines, end))
    const truncated = end - start > maxLines ? `\n// ... truncated (${end - start} lines total)` : ''
    return slice.join('\n') + truncated
  } catch { return null }
}

// ── Prompt Building ─────────────────────────────────────

function buildScenarioPrompt(
  subgraph: CallSubgraph,
  sourceSections: string,
  repo: string,
): string {
  // Build graph description
  const nodeList = Array.from(subgraph.nodes.values())
    .map(n => `  ${n.file}::${n.name} [${n.module} > ${n.subModule}]`)
    .join('\n')

  const edgeList = subgraph.edges
    .filter(e => e.crossModule)
    .map(e => {
      const fromNode = subgraph.nodes.get(e.from)
      const toNode = subgraph.nodes.get(e.to)
      if (!fromNode || !toNode) return null
      return `  ${fromNode.name} (${fromNode.module}) → ${toNode.name} (${toNode.module})`
    })
    .filter(Boolean)
    .join('\n')

  const branchDesc = subgraph.branches.map(k => {
    const n = subgraph.nodes.get(k)
    return n ? `  ${n.name} (${n.file}) — branches to ${subgraph.edges.filter(e => e.from === k && e.crossModule).length} modules` : null
  }).filter(Boolean).join('\n')

  const mergeDesc = subgraph.merges.map(k => {
    const n = subgraph.nodes.get(k)
    return n ? `  ${n.name} (${n.file}) — called from multiple modules` : null
  }).filter(Boolean).join('\n')

  return `You are analyzing a cross-module execution path in "${repo}" starting from \`${subgraph.entry.name}\` (${subgraph.entry.file}).

## Call Graph

### Nodes (${subgraph.nodes.size} functions)
${nodeList}

### Cross-Module Edges
${edgeList}

### Branch Points (function dispatches to multiple modules)
${branchDesc || '  (none)'}

### Merge Points (function called from multiple modules)
${mergeDesc || '  (none)'}

### Loops
${subgraph.loops.length > 0 ? subgraph.loops.map(l => `  ${l.join(' ↔ ')}`).join('\n') : '  (none detected in CALLS graph — check source for iteration patterns)'}

## Source Code of Key Functions

${sourceSections}

## Task

From this call graph and source code, identify 1-3 SPECIFIC scenarios. Each scenario should be a concrete user action with a specific outcome — not "user edits a file" but "user edits a file that doesn't exist yet → FileWrite creates it → permission check for new file in sandboxed directory → sandbox path validation rejects symlinks → error surfaces as tool_result".

For each scenario:

1. **Trigger**: The exact user action or system event
2. **Mermaid flowchart** showing the execution path with:
   - Decision branches (if/else, match/switch)
   - Loops (retry, tool execution loop, polling)
   - Error paths (what happens when each step fails)
   - Use actual function names and file paths as node labels
3. **Step-by-step trace** with:
   - Which function, which file, which line range
   - What decision is made and WHY (from comments/code logic)
   - What data flows between steps
4. **Key code snippets** — the actual TypeScript at each branch point or critical decision
5. **What could go wrong** — specific failure modes and recovery strategies visible in the code

Write in Chinese. Be extremely specific — every claim should be traceable to a function and file.

Output: Markdown with \`\`\`mermaid code blocks (properly fenced with triple backticks). Use flowchart TD for the diagrams, not sequence diagrams.`
}

// ── Main Pipeline ───────────────────────────────────────

export async function discoverScenarios(opts: ScenarioOpts): Promise<{ scenarioCount: number; tokens: number; durationMs: number }> {
  const {
    dbSession, ai, repo, repoPath, outputDir,
    entryPoints: userEntries,
    maxEntryPoints = 8,
    concurrency = 2,
    onProgress = () => {},
  } = opts
  const startTime = Date.now()
  let totalTokens = 0

  fs.mkdirSync(outputDir, { recursive: true })

  // 1. Find entry points
  let entries: { name: string; file: string; moduleSpan: number }[]
  if (userEntries) {
    // Resolve user-specified function names to files
    entries = []
    for (const name of userEntries) {
      const res = await dbSession.run(`
        MATCH (fn:CodeEntity {entity_type: 'function', name: $name, repo: $repo})
        MATCH (f:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(fn)
        MATCH (fn)-[:CALLS]->(callee:CodeEntity)-[:BELONGS_TO]->(sm2:SemanticModule)
        MATCH (fn)-[:BELONGS_TO]->(sm:SemanticModule)
        WHERE sm.id <> sm2.id
        WITH fn, f, count(DISTINCT sm2) AS span
        RETURN f.path AS file, span ORDER BY span DESC LIMIT 1
      `, { name, repo })
      if (res.records.length > 0) {
        entries.push({ name, file: res.records[0].get('file') as string, moduleSpan: toNum(res.records[0].get('span')) })
      }
    }
  } else {
    entries = await findEntryPoints(dbSession, repo, maxEntryPoints)
  }

  onProgress(`Found ${entries.length} entry points`)

  // 2. For each entry, extract subgraph + source + LLM
  let scenarioCount = 0

  for (const entry of entries) {
    onProgress(`\nExtracting: ${entry.name} (${entry.file}, spans ${entry.moduleSpan} modules)...`)

    const subgraph = await extractSubgraph(dbSession, repo, entry.name, entry.file)
    onProgress(`  Graph: ${subgraph.nodes.size} nodes, ${subgraph.edges.filter(e => e.crossModule).length} cross-module edges, ${subgraph.branches.length} branches, ${subgraph.merges.length} merges`)

    // Read source for key functions: entry + branches + merges + first callee of each cross-module edge
    const keyNodeKeys = new Set<string>([
      subgraph.entryKey,
      ...subgraph.branches,
      ...subgraph.merges,
      ...subgraph.loops.flat(),
    ])
    // Also add cross-module edge targets (up to 15)
    let crossTargets = 0
    for (const e of subgraph.edges) {
      if (e.crossModule && crossTargets < 15) {
        keyNodeKeys.add(e.to)
        crossTargets++
      }
    }

    const sourceSections: string[] = []
    for (const key of keyNodeKeys) {
      const node = subgraph.nodes.get(key)
      if (!node || node.lineStart <= 0) continue
      const source = readFunctionSource(repoPath, node.file, node.lineStart, node.lineEnd)
      if (source) {
        const tag = subgraph.branches.includes(key) ? ' [BRANCH POINT]' :
                    subgraph.merges.includes(key) ? ' [MERGE POINT]' :
                    key === subgraph.entryKey ? ' [ENTRY]' : ''
        sourceSections.push(`### ${node.file}::${node.name}${tag}\n\`\`\`typescript\n${source}\n\`\`\``)
      }
    }

    onProgress(`  Source: ${sourceSections.length} key functions read`)

    // LLM call
    const prompt = buildScenarioPrompt(subgraph, sourceSections.join('\n\n'), repo)
    const raw = await ai.call(prompt, { timeoutMs: 600000 })
    const tokens = (ai.lastUsage?.input_tokens ?? 0) + (ai.lastUsage?.output_tokens ?? 0)
    totalTokens += tokens

    // Fix mermaid blocks
    const fixed = raw.replace(
      /^mermaid\n((?:graph |sequenceDiagram|flowchart |classDiagram)[\s\S]*?)(?=\n---|\n## |\n#+ |\n\n[A-Z]|\n$)/gm,
      '```mermaid\n$1\n```',
    )

    const safeName = entry.name.replace(/[^a-zA-Z0-9]/g, '_')
    const outPath = path.join(outputDir, `scenario_${safeName}.md`)
    fs.writeFileSync(outPath, fixed, 'utf-8')

    onProgress(`  ✓ ${entry.name} (${tokens.toLocaleString()} tokens)`)
    scenarioCount++
  }

  return { scenarioCount, tokens: totalTokens, durationMs: Date.now() - startTime }
}
