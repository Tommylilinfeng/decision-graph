#!/usr/bin/env node
import * as fs from 'fs'
import * as path from 'path'
import { indexRepo } from './pipeline'
import { openDatabase, closeDatabase } from './storage'
import { UnresolvedReason } from './resolve'
import { runInject } from './inject'
import { sessionStatePath, writeShown, deleteState } from './session'

const BUCKETS: UnresolvedReason[] = [
  'member_chain', 'external',
  'default_import', 'namespace_import',
  'barrel_miss', 'unknown_bare',
]

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const cmd = args[0]

  if (cmd === 'index') {
    if (!args[1]) usage()
    const result = await indexRepo(args[1])
    printSummary(result)
    return
  }

  if (cmd === 'inject') {
    const stdin = fs.readFileSync(0, 'utf8')
    const result = runInject(stdin)
    if (result.stdout) process.stdout.write(result.stdout)
    return
  }

  if (cmd === 'clear-shown') {
    const stdin = fs.readFileSync(0, 'utf8')
    runClearShown(stdin)
    return
  }

  if (cmd === 'delete-state') {
    const stdin = fs.readFileSync(0, 'utf8')
    runDeleteState(stdin)
    return
  }

  if (cmd === 'stats') {
    const pathArgIdx = args.indexOf('--path')
    const target = pathArgIdx >= 0 ? args[pathArgIdx + 1] ?? '.' : '.'
    const dbPath = path.join(path.resolve(target), '.ctx', 'graph.db')
    if (!fs.existsSync(dbPath)) {
      process.stderr.write(`no index found at ${target} — run 'context-chain index' first\n`)
      process.exit(1)
    }
    const db = openDatabase(dbPath)
    const nodes = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c
    const edges = (db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number }).c
    closeDatabase(db)
    process.stdout.write(`${nodes} nodes, ${edges} edges\n`)
    return
  }

  usage()
}

function usage(): never {
  process.stderr.write('usage: context-chain index <path>\n')
  process.stderr.write('       context-chain stats [--path <path>]\n')
  process.stderr.write('       context-chain inject          (PreToolUse hook; reads stdin JSON)\n')
  process.stderr.write('       context-chain clear-shown     (PostCompact hook; reads stdin JSON)\n')
  process.stderr.write('       context-chain delete-state    (SessionEnd hook; reads stdin JSON)\n')
  process.exit(1)
}

interface HookEnv { session_id?: string; cwd?: string }

function readHookEnv(stdin: string): HookEnv | null {
  try {
    const raw = JSON.parse(stdin) as HookEnv
    const cwd = raw.cwd ?? process.env.CLAUDE_PROJECT_DIR
    if (!cwd) return null
    return { session_id: raw.session_id, cwd }
  } catch { return null }
}

export function runClearShown(stdin: string): void {
  const env = readHookEnv(stdin)
  if (!env || !env.session_id || !env.cwd) return
  writeShown(sessionStatePath(env.cwd, env.session_id), new Set())
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export function runDeleteState(stdin: string): void {
  const env = readHookEnv(stdin)
  if (!env || !env.session_id || !env.cwd) return
  deleteState(env.cwd, env.session_id, SEVEN_DAYS_MS)
}

function printSummary(r: Awaited<ReturnType<typeof indexRepo>>): void {
  const secs = (r.durationMs / 1000).toFixed(1)
  process.stdout.write(`Indexed ${r.files} files in ${secs}s\n`)
  process.stdout.write(`  ${r.functions} functions\n`)
  if (r.calls > 0) {
    const pct = Math.round((r.resolved / r.calls) * 100)
    process.stdout.write(`  ${r.calls} calls → ${r.resolved} resolved (${pct}%), ${r.unresolved} unresolved:\n`)
    for (const b of BUCKETS) {
      process.stdout.write(`    ${b.padEnd(18)} ${r.reasons[b]}\n`)
    }
  } else {
    process.stdout.write(`  0 calls\n`)
  }
  if (r.parseFailures.length > 0) {
    const first = r.parseFailures.slice(0, 3).map(f => f.file).join(', ')
    process.stdout.write(`  ${r.parseFailures.length} parse failures: ${first}\n`)
  }
  if (r.filesWithParseErrors > 0) {
    process.stdout.write(`  ${r.filesWithParseErrors} files had parse errors (partial results used)\n`)
  }
  if (r.duplicateWarnings.length > 0) {
    const first = r.duplicateWarnings.slice(0, 3).map(w => `${w.file}::${w.name}`).join(', ')
    process.stdout.write(`  ${r.duplicateWarnings.length} duplicate function names dropped: ${first}\n`)
  }
}

if (require.main === module) {
  main().catch(e => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  })
}
