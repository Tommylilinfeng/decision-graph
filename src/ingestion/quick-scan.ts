/**
 * quick-scan.ts
 *
 * Zero-config codebase scanner.
 * User provides a directory path. We:
 * 1. Walk the directory to find code files
 * 2. Ask a lite LLM to rank files by importance
 * 3. Deep-analyze top files to extract design decisions
 * 4. Stream results to stdout for SSE
 *
 * Usage: ts-node --transpile-only quick-scan.ts --dir /path/to/repo [--top N] [--concurrency N]
 */

import fs from 'fs'
import path from 'path'
import { createAIProvider } from '../ai'
import { loadConfig } from '../config'

// ── CLI args ────────────────────────────────────────

const args = process.argv.slice(2)
function arg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 ? args[idx + 1] : undefined
}

const DIR = arg('dir')
const TOP_N = parseInt(arg('top') || '10')
const CONCURRENCY = parseInt(arg('concurrency') || '2')

if (!DIR) {
  console.error('Usage: quick-scan --dir <directory> [--top N] [--concurrency N]')
  process.exit(1)
}

const resolvedDir = path.resolve(DIR)
if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
  console.error(`Directory not found: ${resolvedDir}`)
  process.exit(1)
}

// ── File discovery ──────────────────────────────────

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.swift',
  '.rb', '.php', '.vue', '.svelte',
])

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'out',
  '__pycache__', '.venv', 'venv', 'vendor', 'target', '.turbo',
  'coverage', '.cache', '.parcel-cache', '.svelte-kit',
])

const SKIP_PATTERNS = [
  /\.min\./,
  /\.d\.ts$/,
  /\.test\./,
  /\.spec\./,
  /\.stories\./,
  /\.config\./,
  /\/migrations\//,
  /\/fixtures\//,
  /\/mocks\//,
  /\/__tests__\//,
]

interface FileInfo {
  relativePath: string
  absolutePath: string
  size: number
  lines: number
  firstLines: string
}

function walkDir(dir: string, base: string): FileInfo[] {
  const results: FileInfo[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        results.push(...walkDir(fullPath, base))
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (!CODE_EXTENSIONS.has(ext)) continue
      const relativePath = path.relative(base, fullPath)
      if (SKIP_PATTERNS.some(p => p.test(relativePath))) continue

      try {
        const stat = fs.statSync(fullPath)
        if (stat.size > 500_000) continue // skip files > 500KB
        const content = fs.readFileSync(fullPath, 'utf-8')
        const lines = content.split('\n')
        results.push({
          relativePath,
          absolutePath: fullPath,
          size: stat.size,
          lines: lines.length,
          firstLines: lines.slice(0, 8).join('\n'),
        })
      } catch {
        // skip unreadable files
      }
    }
  }
  return results
}

// ── LLM helpers ─────────────────────────────────────

function parseJsonSafe(raw: string): any {
  // Try to extract JSON from LLM response
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) ||
                    raw.match(/\[[\s\S]*\]/) ||
                    raw.match(/\{[\s\S]*\}/)
  const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : raw
  try {
    return JSON.parse(jsonStr)
  } catch {
    return null
  }
}

async function runWithConcurrency<T, R>(
  items: T[], limit: number, fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let idx = 0

  async function worker() {
    while (idx < items.length) {
      const i = idx++
      results[i] = await fn(items[i])
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

// ── Prompts ─────────────────────────────────────────

function rankPrompt(files: FileInfo[]): string {
  const fileList = files.map(f =>
    `- ${f.relativePath} (${f.lines} lines)\n  ${f.firstLines.split('\n').slice(0, 3).join(' | ')}`
  ).join('\n')

  return `You are analyzing a codebase to find the most important files for understanding its architecture and business logic.

Here are ${files.length} source files:

${fileList}

Select the top ${TOP_N} most important files. Prioritize:
1. Core business logic (not config, not utils, not types-only files)
2. Main entry points and route handlers
3. Files with complex decision-making logic
4. Service/controller files over helper/utility files
5. Larger files that contain substantial logic

Return a JSON array of file paths, ordered from most to least important:
["path/to/most/important.ts", "path/to/second.ts", ...]

Return ONLY the JSON array, no explanation.`
}

function analyzePrompt(filePath: string, code: string): string {
  return `Analyze this source code file and extract design decisions.

File: ${filePath}
\`\`\`
${code}
\`\`\`

For each significant design decision, extract:
- **function**: The function or section name where the decision lives
- **summary**: A concise 1-2 sentence summary of the decision (20-50 words)
- **content**: A detailed explanation of WHY this approach was chosen, what tradeoffs were made, and what alternatives exist (100-400 chars)
- **keywords**: 2-4 keywords for categorization
- **finding_type**: "decision" (intentional choice), "suboptimal" (works but could be better), or "bug" (likely incorrect behavior)
- **critique**: Only for "suboptimal" or "bug" — what should be improved

Focus on:
- Non-obvious design choices (not trivial code)
- Business logic decisions
- Architecture patterns
- Error handling strategies
- Data flow decisions
- Performance tradeoffs

Return a JSON array of findings. If the file has no significant decisions, return [].

[
  {
    "function": "functionName",
    "summary": "...",
    "content": "...",
    "keywords": ["k1", "k2"],
    "finding_type": "decision",
    "critique": null
  }
]

Return ONLY the JSON array.`
}

// ── Main pipeline ───────────────────────────────────

async function main() {
  const startTime = Date.now()

  // Step 1: Discover files
  console.log(`Scanning ${resolvedDir} ...`)
  const files = walkDir(resolvedDir, resolvedDir)
  console.log(`Found ${files.length} source files`)

  if (files.length === 0) {
    console.log('No code files found. Check the directory path.')
    process.exit(0)
  }

  // Load AI provider
  let aiConfig
  try {
    const config = loadConfig()
    aiConfig = config.ai
  } catch {
    // No config file — use defaults
  }
  const ai = createAIProvider(aiConfig)
  console.log(`AI provider: ${ai.name}`)

  // Step 2: Rank files
  console.log(`\nRanking files by importance...`)

  // If few files, skip ranking
  let topFiles: FileInfo[]
  if (files.length <= TOP_N) {
    topFiles = files
    console.log(`Only ${files.length} files — analyzing all`)
  } else {
    // Cap file list for prompt size (send max 200 files to ranker)
    const filesToRank = files
      .sort((a, b) => b.lines - a.lines) // larger files first for ranking
      .slice(0, 200)

    const rankResponse = await ai.call(rankPrompt(filesToRank))
    const rankedPaths = parseJsonSafe(rankResponse) as string[] | null

    if (!rankedPaths || !Array.isArray(rankedPaths)) {
      console.log('Failed to parse ranking, using largest files')
      topFiles = files.sort((a, b) => b.lines - a.lines).slice(0, TOP_N)
    } else {
      // Match ranked paths to file infos
      topFiles = []
      for (const rp of rankedPaths) {
        const match = files.find(f =>
          f.relativePath === rp ||
          f.relativePath.endsWith(rp) ||
          rp.endsWith(f.relativePath)
        )
        if (match && !topFiles.includes(match)) {
          topFiles.push(match)
        }
        if (topFiles.length >= TOP_N) break
      }
      // Fill remaining slots if ranking returned too few
      if (topFiles.length < TOP_N) {
        for (const f of files.sort((a, b) => b.lines - a.lines)) {
          if (!topFiles.includes(f)) topFiles.push(f)
          if (topFiles.length >= TOP_N) break
        }
      }
    }
    console.log(`Selected top ${topFiles.length} files for deep analysis`)
  }

  // Log selected files
  for (const f of topFiles) {
    console.log(`  >> ${f.relativePath} (${f.lines} lines)`)
  }

  // Step 3: Deep analyze each file
  console.log(`\nStarting deep analysis (concurrency: ${CONCURRENCY})...`)

  let totalDecisions = 0
  let filesAnalyzed = 0

  await runWithConcurrency(topFiles, CONCURRENCY, async (file) => {
    try {
      const code = fs.readFileSync(file.absolutePath, 'utf-8')
      // Truncate very large files
      const truncated = code.length > 30_000
        ? code.slice(0, 30_000) + '\n// ... truncated ...'
        : code

      const response = await ai.call(analyzePrompt(file.relativePath, truncated))
      const decisions = parseJsonSafe(response) as any[] | null

      filesAnalyzed++

      if (!decisions || !Array.isArray(decisions) || decisions.length === 0) {
        console.log(`[${filesAnalyzed}/${topFiles.length}] ${file.relativePath} — no decisions`)
        return
      }

      totalDecisions += decisions.length
      console.log(`[${filesAnalyzed}/${topFiles.length}] ${file.relativePath} — ${decisions.length} decisions`)

      for (const d of decisions) {
        // Emit each decision as a structured log line for SSE parsing
        console.log(`DECISION::${JSON.stringify({
          file: file.relativePath,
          function: d.function || '',
          summary: d.summary || '',
          content: d.content || '',
          keywords: d.keywords || [],
          finding_type: d.finding_type || 'decision',
          critique: d.critique || null,
        })}`)
      }
    } catch (err: any) {
      filesAnalyzed++
      console.log(`[${filesAnalyzed}/${topFiles.length}] ${file.relativePath} — error: ${err.message}`)
    }
  })

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\nDone: ${totalDecisions} decisions from ${filesAnalyzed} files in ${elapsed}s`)
  console.log(`Tokens used: ${ai.totalUsage.input_tokens} input, ${ai.totalUsage.output_tokens} output`)
}

main().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
