import * as fs from 'fs'
import * as path from 'path'
import assert from 'node:assert/strict'
import { openDatabase, closeDatabase, upsertNodes } from '../src/storage'
import { decisionsForFunction, createDecision } from '../src/decisions'
import {
  handleRecordDecisions,
  handleResetDecisionCache,
  handleDecisionsByKeyword,
} from '../src/mcp'
import { buildDescription } from '../src/description'
import { sessionStatePath, writeShown, readShown } from '../src/session'

const DB_PATH = '/tmp/ctx-verify-mcp.db'

function cleanup(): void {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + ext) } catch { /* ignore */ }
  }
}

cleanup()
const db = openDatabase(DB_PATH)

upsertNodes(db, [
  { file: 'src/a.ts', name: 'foo', kind: 'function', start_line: 1, end_line: 10 },
  { file: 'src/b.ts', name: 'bar', kind: 'function', start_line: 1, end_line: 5 },
  { file: 'src/c.ts', name: 'baz', kind: 'function', start_line: 1, end_line: 3 },
])

function countDecisions(): number {
  return (db.prepare('SELECT COUNT(*) as c FROM decisions').get() as { c: number }).c
}

function assertRejected(r: ReturnType<typeof handleRecordDecisions>, fragments: string[], label: string): void {
  assert.equal(r.ok, false, `${label}: expected rejection, got success`)
  for (const f of fragments) {
    assert.ok(
      r.message.toLowerCase().includes(f.toLowerCase()),
      `${label}: message "${r.message}" should include "${f}"`,
    )
  }
}

const RETURN_RE = /^recorded \d+ decisions \(ids: [\d, ]+\); anchors live: \d+\/\d+$/

// ── Scenario 1: happy path, function anchor ──────────────────────────────
{
  const r = handleRecordDecisions(db, {
    decisions: [{
      decision: 'use WAL mode',
      anchors: [{ kind: 'function', file: 'src/a.ts', name: 'foo' }],
      keywords: ['concurrency'],
    }],
  })
  assert.equal(r.ok, true)
  assert.match(r.message, RETURN_RE)
  assert.ok(r.message.includes('anchors live: 1/1'), `live stats: ${r.message}`)
  assert.ok(decisionsForFunction(db, 'src/a.ts', 'foo').some(d => d.decision === 'use WAL mode'))
}

// ── Scenario 2: happy path, file anchor ──────────────────────────────────
{
  const r = handleRecordDecisions(db, {
    decisions: [{
      decision: 'src/b.ts is the query entry point',
      anchors: [{ kind: 'file', file: 'src/b.ts' }],
      keywords: ['entry-point'],
    }],
  })
  assert.equal(r.ok, true)
  assert.ok(decisionsForFunction(db, 'src/b.ts', 'bar').some(d => d.decision.includes('query entry point')))
}

// ── Scenario 3: mixed anchors in one decision ────────────────────────────
{
  const r = handleRecordDecisions(db, {
    decisions: [{
      decision: 'cross-cutting: a::foo and b file-level',
      anchors: [
        { kind: 'function', file: 'src/a.ts', name: 'foo' },
        { kind: 'file', file: 'src/b.ts' },
      ],
      keywords: ['cross-cutting'],
    }],
  })
  assert.equal(r.ok, true)
  assert.ok(decisionsForFunction(db, 'src/a.ts', 'foo').some(d => d.decision.startsWith('cross-cutting')))
  assert.ok(decisionsForFunction(db, 'src/b.ts', 'bar').some(d => d.decision.startsWith('cross-cutting')))
}

// ── Scenario 4: missing decision text ────────────────────────────────────
assertRejected(
  handleRecordDecisions(db, { decisions: [{ anchors: [{ kind: 'function', file: 'src/a.ts', name: 'foo' }], keywords: ['tag'] }] }),
  ['decisions[0].decision'],
  'missing decision',
)

// ── Scenario 5: empty anchors ────────────────────────────────────────────
assertRejected(
  handleRecordDecisions(db, { decisions: [{ decision: 'x', anchors: [], keywords: ['tag'] }] }),
  ['decisions[0].anchors must be non-empty'],
  'empty anchors',
)

// ── Scenario 6: function anchor missing name ─────────────────────────────
assertRejected(
  handleRecordDecisions(db, { decisions: [{ decision: 'x', anchors: [{ kind: 'function', file: 'src/a.ts' }], keywords: ['tag'] }] }),
  ['decisions[0].anchors[0].name'],
  'function without name',
)

// ── Scenario 7: file anchor with name ────────────────────────────────────
assertRejected(
  handleRecordDecisions(db, { decisions: [{ decision: 'x', anchors: [{ kind: 'file', file: 'src/a.ts', name: 'something' }], keywords: ['tag'] }] }),
  ["decisions[0].anchors[0] must not include 'name'"],
  'file anchor with name',
)

// ── Scenario 8: invalid kind ─────────────────────────────────────────────
assertRejected(
  handleRecordDecisions(db, { decisions: [{ decision: 'x', anchors: [{ kind: 'directory', file: 'src/a.ts' }], keywords: ['tag'] }] }),
  ['decisions[0].anchors[0].kind'],
  'invalid kind',
)

// ── Scenario 9: session env propagation ──────────────────────────────────
{
  process.env.CONTEXT_CHAIN_SESSION_ID = 'sess-xyz'
  try {
    handleRecordDecisions(db, {
      decisions: [{
        decision: 'tied to a session',
        anchors: [{ kind: 'function', file: 'src/a.ts', name: 'foo' }],
        keywords: ['session-test'],
      }],
    })
  } finally {
    delete process.env.CONTEXT_CHAIN_SESSION_ID
  }
  const row = db
    .prepare(`SELECT session_id FROM decisions WHERE decision = 'tied to a session'`)
    .get() as { session_id: string | null }
  assert.equal(row.session_id, 'sess-xyz', 'session_id from env stored')

  handleRecordDecisions(db, {
    decisions: [{
      decision: 'no-session decision',
      anchors: [{ kind: 'function', file: 'src/a.ts', name: 'foo' }],
      keywords: ['session-test'],
    }],
  })
  const rowNull = db
    .prepare(`SELECT session_id FROM decisions WHERE decision = 'no-session decision'`)
    .get() as { session_id: string | null }
  assert.equal(rowNull.session_id, null, 'session_id null when env unset')
}

// ── Scenario 10: batch happy path (3 decisions in one call) ──────────────
{
  const r = handleRecordDecisions(db, {
    decisions: [
      { decision: 'batch-1 on foo', anchors: [{ kind: 'function', file: 'src/a.ts', name: 'foo' }], keywords: ['batch'] },
      { decision: 'batch-2 on bar', anchors: [{ kind: 'function', file: 'src/b.ts', name: 'bar' }], keywords: ['batch'] },
      { decision: 'batch-3 mixed', anchors: [
        { kind: 'function', file: 'src/c.ts', name: 'baz' },
        { kind: 'file', file: 'src/a.ts' },
      ], keywords: ['batch', 'mixed'] },
    ],
  })
  assert.equal(r.ok, true)
  assert.match(r.message, RETURN_RE)
  assert.ok(/anchors live: 4\/4/.test(r.message), `live stats expected 4/4 in: ${r.message}`)
  assert.ok(decisionsForFunction(db, 'src/a.ts', 'foo').some(d => d.decision === 'batch-1 on foo'))
  assert.ok(decisionsForFunction(db, 'src/b.ts', 'bar').some(d => d.decision === 'batch-2 on bar'))
  assert.ok(decisionsForFunction(db, 'src/c.ts', 'baz').some(d => d.decision === 'batch-3 mixed'))
  assert.ok(decisionsForFunction(db, 'src/a.ts', 'foo').some(d => d.decision === 'batch-3 mixed'),
    'batch-3 should also surface via its file-anchor on src/a.ts')
}

// ── Scenario 11: multi-error accumulation + no write on validation fail ──
{
  const before = countDecisions()
  const VALID_DECISION = 'valid-in-middle-should-not-write'
  const buggyArgs = {
    decisions: [
      { anchors: [{ kind: 'function', file: 'src/a.ts', name: 'foo' }], keywords: ['tag'] },                                       // [0] missing decision
      { decision: 'bad kind', anchors: [{ kind: 'directory', file: 'src/a.ts' }], keywords: ['tag'] },                             // [1] invalid kind
      { decision: VALID_DECISION, anchors: [{ kind: 'function', file: 'src/a.ts', name: 'foo' }], keywords: ['tag'] },             // [2] valid
      { decision: 'fn no name', anchors: [{ kind: 'function', file: 'src/a.ts' }], keywords: ['tag'] },                            // [3] missing name
      { decision: 'bad kw', anchors: [{ kind: 'function', file: 'src/a.ts', name: 'foo' }], keywords: ['Bad'] },                   // [4] invalid keyword
    ],
  }
  const r = handleRecordDecisions(db, buggyArgs)
  assert.equal(r.ok, false)
  for (const frag of [
    'decisions[0].decision',
    'decisions[1].anchors[0].kind',
    'decisions[3].anchors[0].name',
    'decisions[4].keywords[0]',
  ]) {
    assert.ok(r.message.includes(frag), `missing error fragment ${frag}; got: "${r.message}"`)
  }
  assert.ok(!r.message.includes('decisions[2]'), `valid decision [2] must not appear in error; got: "${r.message}"`)
  assert.ok(r.message.includes('\n'), 'errors joined by newlines, not semicolons')
  assert.equal(countDecisions(), before, 'no decisions written when any validation fails')
  const leaked = db.prepare('SELECT COUNT(*) as c FROM decisions WHERE decision = ?').get(VALID_DECISION) as { c: number }
  assert.equal(leaked.c, 0, 'even the valid decision [2] must not have been written')
}

// ── Scenario 12: non-object arguments rejected ───────────────────────────
for (const bad of [null, 'a string', 42, [1, 2, 3]]) {
  const r = handleRecordDecisions(db, bad)
  assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(bad)}`)
  assert.ok(
    r.message.includes('arguments must be an object'),
    `expected 'arguments must be an object' for ${JSON.stringify(bad)}, got "${r.message}"`,
  )
}

// ── Scenario 13: error accumulation capped at MAX_ERRORS_SHOWN (50) ──────
{
  const bigBatch = {
    decisions: Array.from({ length: 60 }, () => ({ anchors: [] as unknown[], keywords: [] as unknown[] })),
  }
  const r = handleRecordDecisions(db, bigBatch)
  assert.equal(r.ok, false)
  assert.ok(r.message.includes('... and '), `expected truncation marker; got: "${r.message.slice(0, 200)}..."`)
  const lines = r.message.split('\n')
  assert.ok(lines.length <= 51, `expected ≤ 51 lines (50 shown + truncation line), got ${lines.length}`)
}

// ── Scenario 14: missing keywords field ──────────────────────────────────
assertRejected(
  handleRecordDecisions(db, { decisions: [{ decision: 'x', anchors: [{ kind: 'function', file: 'src/a.ts', name: 'foo' }] }] }),
  ['decisions[0].keywords'],
  'missing keywords',
)

// ── Scenario 15: empty keywords array ────────────────────────────────────
assertRejected(
  handleRecordDecisions(db, { decisions: [{ decision: 'x', anchors: [{ kind: 'function', file: 'src/a.ts', name: 'foo' }], keywords: [] }] }),
  ['decisions[0].keywords must be non-empty'],
  'empty keywords',
)

// ── Scenario 16: keyword format violations (table-driven) ────────────────
for (const bad of ['Retry', '重试', 'retry!', 'a', 'abc-', '-abc', '1abc']) {
  const r = handleRecordDecisions(db, {
    decisions: [{
      decision: `bad keyword ${bad}`,
      anchors: [{ kind: 'function', file: 'src/a.ts', name: 'foo' }],
      keywords: [bad],
    }],
  })
  assertRejected(r, ['decisions[0].keywords[0]'], `bad keyword "${bad}"`)
}

// ── Scenario 17: duplicate keywords within a single decision ─────────────
assertRejected(
  handleRecordDecisions(db, {
    decisions: [{
      decision: 'dup keywords',
      anchors: [{ kind: 'function', file: 'src/a.ts', name: 'foo' }],
      keywords: ['retry', 'retry'],
    }],
  }),
  ['duplicate'],
  'duplicate keyword',
)

// ── Scenario 18: live anchor stats reflect mix of live/dead ──────────────
{
  const r = handleRecordDecisions(db, {
    decisions: [{
      decision: 'one live one dead',
      anchors: [
        { kind: 'function', file: 'src/a.ts', name: 'foo' },        // live
        { kind: 'function', file: 'src/a.ts', name: 'ghost' },      // dead
      ],
      keywords: ['live-mix'],
    }],
  })
  assert.equal(r.ok, true)
  assert.ok(/anchors live: 1\/2/.test(r.message), `expected 1/2 in: ${r.message}`)
}

// ── Scenario 19: vocab surfaces in buildDescription, frequency desc ──────
{
  // Wipe to make assertion deterministic
  db.exec('DELETE FROM decisions')
  upsertNodes(db, [
    { file: 'src/v.ts', name: 'v', kind: 'function', start_line: 1, end_line: 1 },
  ])
  const args = {
    decisions: [
      { decision: 'd1', anchors: [{ kind: 'function', file: 'src/v.ts', name: 'v' }], keywords: ['retry', 'fallback'] },
      { decision: 'd2', anchors: [{ kind: 'function', file: 'src/v.ts', name: 'v' }], keywords: ['retry'] },
      { decision: 'd3', anchors: [{ kind: 'function', file: 'src/v.ts', name: 'v' }], keywords: ['fallback'] },
      { decision: 'd4', anchors: [{ kind: 'function', file: 'src/v.ts', name: 'v' }], keywords: ['retry'] },
    ],
  }
  const r = handleRecordDecisions(db, args)
  assert.equal(r.ok, true, r.message)

  const desc = buildDescription(db)
  assert.ok(desc.includes('EXISTING KEYWORDS'), 'description includes vocab section')
  // retry count=3, fallback count=2 → "retry, fallback"
  assert.ok(/retry, fallback/.test(desc), `expected "retry, fallback" in: ${desc}`)
}

// ── Scenario 20: reset_decision_cache wipes all session files ────────────
{
  const ROOT = '/tmp/ctx-verify-mcp-reset'
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(path.join(ROOT, '.ctx', 'sessions'), { recursive: true })
  writeShown(sessionStatePath(ROOT, 'sess-a'), new Set([1, 2]))
  writeShown(sessionStatePath(ROOT, 'sess-b'), new Set([3]))

  const r = handleResetDecisionCache(ROOT)
  assert.equal(r.ok, true)
  assert.ok(r.message.includes('2 session files'), `expected count=2, got: ${r.message}`)
  assert.equal(readShown(sessionStatePath(ROOT, 'sess-a')).size, 0)
  assert.equal(readShown(sessionStatePath(ROOT, 'sess-b')).size, 0)
  fs.rmSync(ROOT, { recursive: true, force: true })
}

// ── Scenario 21: reset_decision_cache idempotent ─────────────────────────
{
  const ROOT = '/tmp/ctx-verify-mcp-reset2'
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(path.join(ROOT, '.ctx', 'sessions'), { recursive: true })
  writeShown(sessionStatePath(ROOT, 'a'), new Set([1]))
  const r1 = handleResetDecisionCache(ROOT)
  const r2 = handleResetDecisionCache(ROOT)
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  fs.rmSync(ROOT, { recursive: true, force: true })
}

// ── Scenario 22: reset_decision_cache no session files ───────────────────
{
  const ROOT = '/tmp/ctx-verify-mcp-reset3'
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(path.join(ROOT, '.ctx', 'sessions'), { recursive: true })
  const r = handleResetDecisionCache(ROOT)
  assert.equal(r.ok, true)
  assert.ok(r.message.includes('0 session files'), `expected count=0, got: ${r.message}`)
  fs.rmSync(ROOT, { recursive: true, force: true })
}

// ── Scenario 23: decisions_by_keyword happy path ─────────────────────────
{
  db.exec('DELETE FROM decisions')
  upsertNodes(db, [{ file: 'src/k.ts', name: 'fn', kind: 'function', start_line: 1, end_line: 1 }])
  for (let i = 0; i < 3; i++) {
    createDecision(db, {
      decision: `retry-${i}`,
      anchors: [{ kind: 'function', file: 'src/k.ts', name: 'fn' }],
      keywords: ['retry'],
    })
  }
  for (let i = 0; i < 2; i++) {
    createDecision(db, {
      decision: `other-${i}`,
      anchors: [{ kind: 'function', file: 'src/k.ts', name: 'fn' }],
      keywords: ['other'],
    })
  }
  const r = handleDecisionsByKeyword(db, { keyword: 'retry' })
  assert.equal(r.ok, true)
  assert.ok(r.message.startsWith('3 decisions tagged "retry"'), `got: ${r.message}`)
  for (let i = 0; i < 3; i++) assert.ok(r.message.includes(`retry-${i}`))
}

// ── Scenario 24: decisions_by_keyword no match ───────────────────────────
{
  const r = handleDecisionsByKeyword(db, { keyword: 'nonexistent-tag' })
  assert.equal(r.ok, true)
  assert.ok(r.message.includes('0 decisions'), `got: ${r.message}`)
}

// ── Scenario 25: decisions_by_keyword cap at 50 ──────────────────────────
{
  db.exec('DELETE FROM decisions')
  upsertNodes(db, [{ file: 'src/cap.ts', name: 'fn', kind: 'function', start_line: 1, end_line: 1 }])
  for (let i = 0; i < 60; i++) {
    createDecision(db, {
      decision: `bulk-${i}`,
      anchors: [{ kind: 'function', file: 'src/cap.ts', name: 'fn' }],
      keywords: ['bulk'],
    })
  }
  const r = handleDecisionsByKeyword(db, { keyword: 'bulk' })
  assert.equal(r.ok, true)
  assert.ok(r.message.startsWith('60 decisions tagged "bulk"'))
  assert.ok(r.message.includes('50 of 60 shown'), `cap footer expected; got: ${r.message.slice(-200)}`)
  // Count how many "#" id markers appear in the body — should be 50
  const idMatches = r.message.match(/^#\d+/gm) ?? []
  assert.equal(idMatches.length, 50, `expected 50 entries, got ${idMatches.length}`)
}

// ── Scenario 26: decisions_by_keyword empty keyword rejected ─────────────
{
  const r = handleDecisionsByKeyword(db, { keyword: '' })
  assert.equal(r.ok, false)
  assert.ok(r.message.includes('non-empty'), `got: ${r.message}`)

  const r2 = handleDecisionsByKeyword(db, {})
  assert.equal(r2.ok, false)
}

// ── Scenario 27: decisions_by_keyword anchor liveness wording ────────────
{
  db.exec('DELETE FROM decisions')
  upsertNodes(db, [{ file: 'src/live.ts', name: 'alive', kind: 'function', start_line: 1, end_line: 1 }])
  createDecision(db, {
    decision: 'live-anchor',
    anchors: [{ kind: 'function', file: 'src/live.ts', name: 'alive' }],
    keywords: ['liveness'],
  })
  createDecision(db, {
    decision: 'dead-anchor',
    anchors: [{ kind: 'function', file: 'src/live.ts', name: 'ghost' }],
    keywords: ['liveness'],
  })
  const r = handleDecisionsByKeyword(db, { keyword: 'liveness' })
  assert.equal(r.ok, true)
  assert.ok(/function src\/live\.ts::alive \(live\)/.test(r.message), `(live) wording: ${r.message}`)
  assert.ok(/function src\/live\.ts::ghost \(dead\)/.test(r.message), `(dead) wording: ${r.message}`)
}

closeDatabase(db)
cleanup()
console.log('OK')
