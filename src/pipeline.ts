import * as fs from 'fs'
import * as path from 'path'
import { globSync } from 'glob'
import {
  openDatabase, closeDatabase, upsertNodes, insertEdges,
  NodeInput, EdgeInput,
} from './storage'
import {
  initParser, extractFromFile, Language,
  ExtractedFunction, ExtractedImport,
} from './extract'
import { resolveImport } from './resolve-imports'
import { resolveCall, buildRegistry, ResolverImport, Registry, UnresolvedReason } from './resolve'

const EMPTY_REASONS = (): Record<UnresolvedReason, number> => ({
  member_chain: 0, external: 0,
  default_import: 0, namespace_import: 0,
  barrel_miss: 0, unknown_bare: 0,
})

export interface PipelineResult {
  files: number
  functions: number
  calls: number
  resolved: number
  unresolved: number
  reasons: Record<UnresolvedReason, number>
  parseFailures: Array<{ file: string; error: string }>
  filesWithParseErrors: number
  duplicateWarnings: Array<{ file: string; name: string }>
  durationMs: number
}

interface ParsedFile {
  file: string
  functions: ExtractedFunction[]
  imports: ExtractedImport[]
  hadParseErrors: boolean
  duplicateFunctionNames: string[]
}

const IGNORE = [
  '**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**',
  '**/.git/**', '**/.ctx/**', '**/__tests__/**',
  '**/.next/**', '**/.turbo/**', '**/.vercel/**', '**/.cache/**',
  '**/coverage/**',
  '**/*.test.ts', '**/*.test.tsx', '**/*.test.js',
  '**/*.spec.ts', '**/*.spec.js',
  '**/*.config.ts', '**/*.config.tsx',
  '**/*.config.js', '**/*.config.mjs', '**/*.config.cjs',
  '**/*.d.ts', '**/*.min.js', '**/*.bundle.js',
]
const PATTERN = '**/*.{ts,tsx,js,jsx,mjs,cjs}'

export async function indexRepo(rootDir: string): Promise<PipelineResult> {
  const start = Date.now()
  const absRoot = path.resolve(rootDir)
  fs.mkdirSync(path.join(absRoot, '.ctx'), { recursive: true })
  const db = openDatabase(path.join(absRoot, '.ctx', 'graph.db'))

  try {
    await initParser()
    const files = discoverFiles(absRoot)
    const parseFailures: Array<{ file: string; error: string }> = []
    const parsed = parseAll(absRoot, files, parseFailures)
    const perFileImports = resolveAllImports(parsed, absRoot)

    const stats = db.transaction(() => {
      db.exec('DELETE FROM nodes')
      return writeGraph(db, parsed, perFileImports)
    })()

    const filesWithParseErrors = parsed.filter(p => p.hadParseErrors).length
    const duplicateWarnings = parsed.flatMap(p =>
      p.duplicateFunctionNames.map(name => ({ file: p.file, name })),
    )

    return {
      files: parsed.length,
      functions: stats.functions,
      calls: stats.calls,
      resolved: stats.resolved,
      unresolved: stats.calls - stats.resolved,
      reasons: stats.reasons,
      parseFailures,
      filesWithParseErrors,
      duplicateWarnings,
      durationMs: Date.now() - start,
    }
  } finally {
    closeDatabase(db)
  }
}

function discoverFiles(absRoot: string): string[] {
  const paths = globSync(PATTERN, {
    cwd: absRoot, ignore: IGNORE, nodir: true, follow: false,
  })
  return paths.map(p => p.split(path.sep).join('/')).sort()
}

function languageFromFile(file: string): Language | null {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.ts') return 'typescript'
  if (ext === '.tsx') return 'tsx'
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'javascript'
  return null
}

function parseAll(absRoot: string, files: string[], failures: Array<{ file: string; error: string }>): ParsedFile[] {
  const parsed: ParsedFile[] = []
  for (const file of files) {
    const lang = languageFromFile(file)
    if (!lang) continue
    try {
      const source = fs.readFileSync(path.join(absRoot, file), 'utf8')
      const result = extractFromFile(source, lang)
      parsed.push({
        file,
        functions: result.functions,
        imports: result.imports,
        hadParseErrors: result.hadParseErrors,
        duplicateFunctionNames: result.duplicateFunctionNames,
      })
    } catch (e) {
      failures.push({ file, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return parsed
}

function resolveAllImports(parsed: ParsedFile[], absRoot: string): Map<string, ResolverImport[]> {
  const perFile = new Map<string, ResolverImport[]>()
  for (const p of parsed) {
    const imports: ResolverImport[] = p.imports.map(imp => {
      const r = resolveImport(imp.module_specifier, p.file, absRoot)
      return {
        local_name: imp.local_name,
        imported_name: imp.imported_name,
        is_default: imp.is_default,
        is_namespace: imp.is_namespace,
        resolved_file: r.kind === 'resolved' ? r.path : null,
      }
    })
    perFile.set(p.file, imports)
  }
  return perFile
}

interface WriteStats {
  functions: number
  calls: number
  resolved: number
  reasons: Record<UnresolvedReason, number>
}

function writeGraph(
  db: ReturnType<typeof openDatabase>,
  parsed: ParsedFile[],
  perFileImports: Map<string, ResolverImport[]>,
): WriteStats {
  const nodeInputs: NodeInput[] = []
  for (const p of parsed) {
    for (const fn of p.functions) {
      nodeInputs.push({
        file: p.file, name: fn.name, kind: 'function',
        start_line: fn.start_line, end_line: fn.end_line,
      })
    }
  }
  const ids = upsertNodes(db, nodeInputs)
  const registry = buildRegistry(
    nodeInputs.map((n, i) => ({ id: ids[i], file: n.file, name: n.name })),
  )

  const edges: EdgeInput[] = []
  const reasons = EMPTY_REASONS()
  let callCount = 0
  let resolvedCount = 0
  let idx = 0
  for (const p of parsed) {
    const imports = perFileImports.get(p.file) ?? []
    for (const fn of p.functions) {
      const sourceId = ids[idx++]
      for (const callee of fn.calls) {
        callCount++
        const r = resolveCall(callee, p.file, imports, registry)
        if (typeof r === 'number') {
          resolvedCount++
          edges.push({ source_id: sourceId, target_id: r, kind: 'calls' })
        } else {
          reasons[r.unresolved]++
        }
      }
    }
  }

  insertEdges(db, edges)
  return { functions: nodeInputs.length, calls: callCount, resolved: resolvedCount, reasons }
}
