import * as fs from 'fs'
import * as path from 'path'
import { openDatabase, closeDatabase, Db } from './storage'
import {
  Decision, Anchor,
  decisionsForFile, keywordsForDecisions, anchorsForDecisions,
} from './decisions'
import { sessionStatePath, readShown, writeShown } from './session'

const CHAR_BUDGET = 8000
const FALLBACK_SESSION = '_default'

interface HookInput {
  tool_input?: { file_path?: string }
  session_id?: string
  cwd?: string
}

export interface InjectResult {
  stdout: string
  stateAfter: Set<number>
}

export function runInject(stdinText: string): InjectResult {
  const empty: InjectResult = { stdout: '', stateAfter: new Set() }
  let input: HookInput
  try { input = JSON.parse(stdinText) as HookInput } catch { return empty }

  const filePath = input.tool_input?.file_path
  if (!filePath) return empty

  const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR
  if (!cwd) return empty

  const dbPath = path.join(cwd, '.ctx', 'graph.db')
  if (!fs.existsSync(dbPath)) return empty

  const rel = relativizePath(filePath, cwd)
  if (rel === null) return empty

  const sessionId = input.session_id ?? FALLBACK_SESSION
  const statePath = sessionStatePath(cwd, sessionId)

  const db = openDatabase(dbPath)
  try {
    const decisions = decisionsForFile(db, rel)
    if (decisions.length === 0) return empty

    const shown = readShown(statePath)
    const newOnes = decisions.filter(d => !shown.has(d.id))
    const previouslyShown = decisions.filter(d => shown.has(d.id))

    const allIds = decisions.map(d => d.id)
    const kwMap = keywordsForDecisions(db, allIds)
    const anchorMap = anchorsForDecisions(db, allIds)

    const text = formatInject({
      file: rel,
      total: decisions.length,
      newOnes,
      previouslyShown,
      kwMap,
      anchorMap,
    })

    const nextShown = new Set(shown)
    for (const d of decisions) nextShown.add(d.id)
    writeShown(statePath, nextShown)

    const stdout = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext: text,
      },
    })
    return { stdout, stateAfter: nextShown }
  } finally {
    closeDatabase(db)
  }
}

function relativizePath(filePath: string, cwd: string): string | null {
  const cwdPosix = cwd.split(path.sep).join('/')
  const filePosix = filePath.split(path.sep).join('/')
  if (path.isAbsolute(filePath)) {
    const prefix = cwdPosix.endsWith('/') ? cwdPosix : cwdPosix + '/'
    if (!filePosix.startsWith(prefix)) return null
    return filePosix.slice(prefix.length)
  }
  if (filePosix.startsWith('../')) return null
  return filePosix
}

interface FormatArgs {
  file: string
  total: number
  newOnes: Decision[]
  previouslyShown: Decision[]
  kwMap: Map<number, string[]>
  anchorMap: Map<number, Anchor[]>
}

function formatInject(a: FormatArgs): string {
  if (a.newOnes.length === 0) {
    return `[context-chain] ${a.total} decisions on ${a.file} shown earlier this session.\n` +
           `(call mcp__context-chain__reset_decision_cache if context was compacted)`
  }

  const fileLevel: Decision[] = []
  const byFunction = new Map<string, Decision[]>()
  for (const d of a.newOnes) {
    const anchors = (a.anchorMap.get(d.id) ?? []).filter(an => anchorMatchesFile(an, a.file))
    const hasFileLevel = anchors.some(an => an.kind === 'file')
    if (hasFileLevel) {
      fileLevel.push(d)
    } else {
      for (const an of anchors) {
        if (an.kind === 'function') {
          const list = byFunction.get(an.name) ?? []
          if (!list.includes(d)) list.push(d)
          byFunction.set(an.name, list)
        }
      }
    }
  }

  const headerNew = `${a.newOnes.length} new`
  const headerSeen = a.previouslyShown.length > 0 ? `, ${a.previouslyShown.length} shown earlier` : ''
  const header = `[context-chain] ${a.total} decisions on ${a.file} (${headerNew}${headerSeen})`

  const lines: string[] = [header, '', 'NEW:']

  if (fileLevel.length > 0) {
    lines.push('file-level:')
    for (const d of fileLevel) lines.push(`  ${formatDecisionLine(d, a.kwMap)}`)
  }

  const fnNames = Array.from(byFunction.keys()).sort()
  for (const fn of fnNames) {
    lines.push(`fn ${fn}():`)
    for (const d of byFunction.get(fn)!) lines.push(`  ${formatDecisionLine(d, a.kwMap)}`)
  }

  if (a.previouslyShown.length > 0) {
    lines.push('')
    lines.push(`(${a.previouslyShown.length} decision${a.previouslyShown.length > 1 ? 's' : ''} on this file already shown earlier this session.`)
    lines.push(`If your context was compacted/summarized, call mcp__context-chain__reset_decision_cache.)`)
  }

  return applyCap(lines, a.total)
}

function anchorMatchesFile(an: Anchor, file: string): boolean {
  return an.file === file
}

function formatDecisionLine(d: Decision, kwMap: Map<number, string[]>): string {
  const kws = kwMap.get(d.id) ?? []
  return `[${kws.join(', ')}] ${d.decision}`
}

function applyCap(lines: string[], total: number): string {
  let text = lines.join('\n')
  if (text.length <= CHAR_BUDGET) return text
  let kept: string[] = []
  for (const line of lines) {
    const candidate = [...kept, line].join('\n')
    if (candidate.length > CHAR_BUDGET - 200) break
    kept.push(line)
  }
  const remaining = lines.length - kept.length
  kept.push('')
  kept.push(`(${remaining} additional lines truncated; ${total} decisions total on this file —`)
  kept.push(` call mcp__context-chain__decisions_by_keyword or query .ctx/graph.db directly)`)
  return kept.join('\n')
}
