#!/usr/bin/env node
import * as fs from 'fs'
import * as path from 'path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { openDatabase, closeDatabase, Db } from './storage'
import {
  createDecision,
  liveAnchorCount,
  decisionsByKeyword,
  keywordsForDecisions,
  anchorsForDecisions,
  AnchorInput,
  CreateDecisionInput,
  Decision,
  Anchor,
} from './decisions'
import { buildDescription } from './description'
import { wipeAllStateFiles } from './session'

const MAX_ERRORS_SHOWN = 50
const KEYWORD_QUERY_CAP = 50
const KEYWORD_RE = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/

const RESET_CACHE_TOOL = {
  name: 'reset_decision_cache',
  description:
    'Reset which decisions have been shown to you this session. Call this if you sense your context was compacted, summarized, or rewound — those events drop earlier injected decisions silently. After reset, the next file Read re-injects all relevant decisions.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

const KEYWORD_QUERY_TOOL = {
  name: 'decisions_by_keyword',
  description:
    "Return all decisions tagged with a given keyword. Use to focus on a topic across the codebase (e.g. all 'retry' decisions). Output is decision text + anchors + other keywords. Capped at 50.",
  inputSchema: {
    type: 'object',
    properties: { keyword: { type: 'string' } },
    required: ['keyword'],
    additionalProperties: false,
  },
}

const TOOL_SCHEMA_BASE = {
  name: 'record_decisions',
  inputSchema: {
    type: 'object',
    properties: {
      decisions: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            decision: { type: 'string' },
            keywords: { type: 'array', minItems: 1, items: { type: 'string' } },
            anchors: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['function', 'file'] },
                  file: { type: 'string' },
                  name: { type: 'string', description: "required when kind='function'; omit when kind='file'" },
                },
                required: ['kind', 'file'],
              },
            },
          },
          required: ['decision', 'keywords', 'anchors'],
        },
      },
    },
    required: ['decisions'],
  },
}

type ValidateResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] }

export type HandleResult =
  | { ok: true; message: string }
  | { ok: false; message: string }

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validateAnchor(raw: unknown, prefix: string): { anchor?: AnchorInput; errors: string[] } {
  if (!isObject(raw)) return { errors: [`${prefix} must be an object`] }
  const errors: string[] = []
  const kindOk = raw.kind === 'function' || raw.kind === 'file'
  if (!kindOk) errors.push(`${prefix}.kind must be 'function' or 'file'`)
  const fileOk = typeof raw.file === 'string' && raw.file.length > 0
  if (!fileOk) errors.push(`${prefix}.file must be a non-empty string`)
  if (raw.kind === 'function') {
    if (typeof raw.name !== 'string' || raw.name.length === 0) {
      errors.push(`${prefix}.name required when kind='function'`)
    }
  } else if (raw.kind === 'file') {
    if ('name' in raw) errors.push(`${prefix} must not include 'name' when kind='file'`)
  }
  if (errors.length > 0) return { errors }
  return raw.kind === 'function'
    ? { anchor: { kind: 'function', file: raw.file as string, name: raw.name as string }, errors }
    : { anchor: { kind: 'file', file: raw.file as string }, errors }
}

function validateKeywords(raw: unknown, prefix: string): { keywords: string[]; errors: string[] } {
  const errors: string[] = []
  const keywords: string[] = []
  if (!Array.isArray(raw)) {
    errors.push(`${prefix} must be an array`)
    return { keywords, errors }
  }
  if (raw.length === 0) {
    errors.push(`${prefix} must be non-empty`)
    return { keywords, errors }
  }
  const seen = new Set<string>()
  for (let k = 0; k < raw.length; k++) {
    const kw = raw[k]
    if (typeof kw !== 'string') {
      errors.push(`${prefix}[${k}] must be a string`)
    } else if (!KEYWORD_RE.test(kw)) {
      errors.push(`${prefix}[${k}] "${kw}" must match ${KEYWORD_RE.source}`)
    } else if (seen.has(kw)) {
      errors.push(`${prefix}[${k}] duplicate "${kw}"`)
    } else {
      seen.add(kw)
      keywords.push(kw)
    }
  }
  return { keywords, errors }
}

function validateDecision(raw: unknown, prefix: string): { input?: CreateDecisionInput; errors: string[] } {
  if (!isObject(raw)) return { errors: [`${prefix} must be an object`] }
  const errors: string[] = []
  const decisionOk = typeof raw.decision === 'string' && raw.decision.length > 0
  if (!decisionOk) errors.push(`${prefix}.decision must be a non-empty string`)
  const anchors: AnchorInput[] = []
  if (!Array.isArray(raw.anchors)) {
    errors.push(`${prefix}.anchors must be an array`)
  } else if (raw.anchors.length === 0) {
    errors.push(`${prefix}.anchors must be non-empty`)
  } else {
    for (let j = 0; j < raw.anchors.length; j++) {
      const { anchor, errors: anchErrors } = validateAnchor(raw.anchors[j], `${prefix}.anchors[${j}]`)
      errors.push(...anchErrors)
      if (anchor) anchors.push(anchor)
    }
  }
  const { keywords, errors: kwErrors } = validateKeywords(raw.keywords, `${prefix}.keywords`)
  errors.push(...kwErrors)
  if (errors.length > 0) return { errors }
  return { input: { decision: raw.decision as string, anchors, keywords }, errors }
}

function validateRecordArgs(raw: unknown): ValidateResult<CreateDecisionInput[]> {
  if (!isObject(raw)) return { ok: false, errors: ['arguments must be an object'] }
  if (!Array.isArray(raw.decisions)) return { ok: false, errors: ['decisions must be an array'] }
  if (raw.decisions.length === 0) return { ok: false, errors: ['decisions must be a non-empty array'] }
  const errors: string[] = []
  const inputs: CreateDecisionInput[] = []
  for (let i = 0; i < raw.decisions.length; i++) {
    const { input, errors: decErrors } = validateDecision(raw.decisions[i], `decisions[${i}]`)
    errors.push(...decErrors)
    if (input) inputs.push(input)
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: inputs }
}

function joinErrors(errors: string[]): string {
  if (errors.length <= MAX_ERRORS_SHOWN) return errors.join('\n')
  const extra = errors.length - MAX_ERRORS_SHOWN
  return [...errors.slice(0, MAX_ERRORS_SHOWN), `... and ${extra} more`].join('\n')
}

export function handleRecordDecisions(db: Db, rawArgs: unknown): HandleResult {
  const r = validateRecordArgs(rawArgs)
  if (!r.ok) return { ok: false, message: joinErrors(r.errors) }
  const session_id = process.env.CONTEXT_CHAIN_SESSION_ID
  const ids: number[] = []
  db.transaction(() => {
    for (const input of r.value) {
      ids.push(createDecision(db, {
        ...input,
        ...(session_id ? { session_id } : {}),
      }))
    }
  })()
  const stats = liveAnchorCount(db, ids)
  return {
    ok: true,
    message: `recorded ${ids.length} decisions (ids: ${ids.join(', ')}); anchors live: ${stats.live}/${stats.total}`,
  }
}

export function handleResetDecisionCache(projectRoot: string): HandleResult {
  const n = wipeAllStateFiles(projectRoot)
  return { ok: true, message: `decision cache reset (${n} session file${n === 1 ? '' : 's'} wiped)` }
}

export function handleDecisionsByKeyword(db: Db, rawArgs: unknown): HandleResult {
  if (!isObject(rawArgs)) return { ok: false, message: 'arguments must be an object' }
  const kw = rawArgs.keyword
  if (typeof kw !== 'string' || kw.length === 0) {
    return { ok: false, message: 'keyword must be a non-empty string' }
  }
  const all = decisionsByKeyword(db, kw)
  if (all.length === 0) {
    return { ok: true, message: `0 decisions tagged "${kw}"` }
  }
  const truncated = all.length > KEYWORD_QUERY_CAP
  const shown = truncated ? all.slice(0, KEYWORD_QUERY_CAP) : all
  const ids = shown.map(d => d.id)
  const kwMap = keywordsForDecisions(db, ids)
  const anchorMap = anchorsForDecisions(db, ids)

  const lines: string[] = [`${all.length} decision${all.length === 1 ? '' : 's'} tagged "${kw}":`, '']
  for (const d of shown) {
    const kws = kwMap.get(d.id) ?? []
    lines.push(`#${d.id} [${kws.join(', ')}] ${d.decision}`)
    const anchors = anchorMap.get(d.id) ?? []
    if (anchors.length > 0) lines.push('  anchors:')
    for (const an of anchors) lines.push(`    ${formatAnchorLine(an)}`)
    lines.push('')
  }
  if (truncated) lines.push(`(${KEYWORD_QUERY_CAP} of ${all.length} shown; refine the keyword)`)
  return { ok: true, message: lines.join('\n').trimEnd() }
}

function formatAnchorLine(a: Anchor): string {
  const liveness = a.live ? 'live' : 'dead'
  return a.kind === 'function'
    ? `function ${a.file}::${a.name} (${liveness})`
    : `file ${a.file} (${liveness})`
}

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
      `run \`context-chain index ${root}\` first\n`,
    )
    process.exit(1)
  }
  const db = openDatabase(dbPath)
  const recordTool = { ...TOOL_SCHEMA_BASE, description: buildDescription(db) }
  const tools = [recordTool, RESET_CACHE_TOOL, KEYWORD_QUERY_TOOL]

  const server = new Server(
    { name: 'context-chain', version: '2.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    let r: HandleResult
    switch (req.params.name) {
      case 'record_decisions':
        r = handleRecordDecisions(db, req.params.arguments)
        break
      case 'reset_decision_cache':
        r = handleResetDecisionCache(root)
        break
      case 'decisions_by_keyword':
        r = handleDecisionsByKeyword(db, req.params.arguments)
        break
      default:
        throw new Error(`unknown tool: ${req.params.name}`)
    }
    return r.ok
      ? { content: [{ type: 'text', text: r.message }] }
      : { content: [{ type: 'text', text: r.message }], isError: true }
  })

  const close = (): void => { closeDatabase(db); process.exit(0) }
  process.on('SIGTERM', close)
  process.on('SIGINT', close)

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

if (require.main === module) {
  main().catch(e => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  })
}
