import * as fs from 'fs'
import * as path from 'path'
import assert from 'node:assert/strict'
import { openDatabase, closeDatabase, upsertNodes } from './src/storage'
import { createDecision, decisionsForFunction, anchorsForDecision, vocabKeywords, liveAnchorCount } from './src/decisions'

const DB_PATH = '/tmp/ctx-verify-decisions.db'

function cleanup(): void {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + ext) } catch { /* ignore */ }
  }
}

cleanup()
const db = openDatabase(DB_PATH)

// ── Scenario 1: create + single function anchor + reverse lookup ─────────
upsertNodes(db, [
  { file: 'src/a.ts', name: 'foo', kind: 'function', start_line: 1, end_line: 10 },
])
const id1 = createDecision(db, {
  decision: 'use WAL mode for concurrency',
  session_id: 'sess-001',
  anchors: [{ kind: 'function', file: 'src/a.ts', name: 'foo' }],
  keywords: ['concurrency'],
})
assert.ok(id1 > 0)

const byFn1 = decisionsForFunction(db, 'src/a.ts', 'foo')
assert.equal(byFn1.length, 1)
assert.equal(byFn1[0].decision, 'use WAL mode for concurrency')
assert.equal(byFn1[0].session_id, 'sess-001')

const anchors1 = anchorsForDecision(db, id1)
assert.equal(anchors1.length, 1)
assert.equal(anchors1[0].kind, 'function')
if (anchors1[0].kind === 'function') {
  assert.equal(anchors1[0].file, 'src/a.ts')
  assert.equal(anchors1[0].name, 'foo')
  assert.equal(anchors1[0].live, true)
}

// ── Scenario 2: multi-anchor fan-out, mixed kinds ────────────────────────
upsertNodes(db, [
  { file: 'src/b.ts', name: 'baz', kind: 'function', start_line: 1, end_line: 5 },
])
const id2 = createDecision(db, {
  decision: 'three-way anchor',
  anchors: [
    { kind: 'function', file: 'src/a.ts', name: 'foo' },
    { kind: 'function', file: 'src/b.ts', name: 'baz' },
    { kind: 'file',     file: 'src/c.ts' },
  ],
  keywords: ['cross-cutting'],
})
const anchors2 = anchorsForDecision(db, id2)
assert.equal(anchors2.length, 3)
const kinds = anchors2.map(a => a.kind).sort()
assert.deepEqual(kinds, ['file', 'function', 'function'])

// File-anchor on src/c.ts should surface via decisionsForFunction even for an arbitrary name
const viaFileAnchor = decisionsForFunction(db, 'src/c.ts', 'anyName')
assert.ok(viaFileAnchor.some(d => d.id === id2), 'file-anchor surfaces through function query')

// ── Scenario 3: empty anchors throws ─────────────────────────────────────
assert.throws(
  () => createDecision(db, { decision: 'orphan', anchors: [], keywords: ['x'] }),
  /at least one anchor/,
)

// ── Scenario 3b: empty keywords throws ───────────────────────────────────
assert.throws(
  () => createDecision(db, {
    decision: 'no keyword',
    anchors: [{ kind: 'function', file: 'src/a.ts', name: 'foo' }],
    keywords: [],
  }),
  /at least one keyword/,
)

// ── Scenario 4: CASCADE on decision delete ───────────────────────────────
db.prepare('DELETE FROM decisions WHERE id = ?').run(id2)
const remaining = db.prepare('SELECT COUNT(*) as c FROM decision_anchors WHERE decision_id = ?')
  .get(id2) as { c: number }
assert.equal(remaining.c, 0, 'decision_anchors cascaded')

// ── Scenario 5: node churn survival (real pipeline wraps DELETE in txn) ──
upsertNodes(db, [
  { file: 'src/d.ts', name: 'hot', kind: 'function', start_line: 1, end_line: 3 },
])
const id5 = createDecision(db, {
  decision: 'hot path decision',
  anchors: [{ kind: 'function', file: 'src/d.ts', name: 'hot' }],
  keywords: ['hot-path'],
})

db.transaction(() => { db.exec('DELETE FROM nodes') })()

const survived = decisionsForFunction(db, 'src/d.ts', 'hot')
assert.equal(survived.length, 1, 'decision survives DELETE FROM nodes')
assert.equal(survived[0].id, id5)

const anchorsAfterWipe = anchorsForDecision(db, id5)
assert.equal(anchorsAfterWipe[0].live, false, 'anchor dead while node gone')

upsertNodes(db, [
  { file: 'src/d.ts', name: 'hot', kind: 'function', start_line: 2, end_line: 4 },
])
const anchorsRelinked = anchorsForDecision(db, id5)
assert.equal(anchorsRelinked[0].live, true, 'live:true after node re-appears')

// ── Scenario 6: dead function anchor query still returns decision ────────
const id6 = createDecision(db, {
  decision: 'decision for a function not indexed yet',
  anchors: [{ kind: 'function', file: 'src/nope.ts', name: 'missing' }],
  keywords: ['aspirational'],
})
const deadResult = decisionsForFunction(db, 'src/nope.ts', 'missing')
assert.equal(deadResult.length, 1)
assert.equal(deadResult[0].id, id6)

const deadAnchors = anchorsForDecision(db, id6)
assert.equal(deadAnchors.length, 1)
assert.equal(deadAnchors[0].live, false)

// ── Scenario 7: path normalization for BOTH kinds ────────────────────────
const rawFnPath = 'src\\win\\a.ts'
const rawFilePath = 'src\\win\\b.ts'
const expectedFn = rawFnPath.split(path.sep).join('/')
const expectedFile = rawFilePath.split(path.sep).join('/')

const id7 = createDecision(db, {
  decision: 'windows-style paths normalized',
  anchors: [
    { kind: 'function', file: rawFnPath, name: 'fnX' },
    { kind: 'file',     file: rawFilePath },
  ],
  keywords: ['paths'],
})
const anchors7 = anchorsForDecision(db, id7)
const fnA = anchors7.find(a => a.kind === 'function')
const fileA = anchors7.find(a => a.kind === 'file')
assert.ok(fnA && fileA, 'both kinds present')
assert.equal(fnA!.file, expectedFn, 'function anchor file normalized')
assert.equal(fileA!.file, expectedFile, 'file anchor file normalized')

assert.ok(
  decisionsForFunction(db, expectedFn, 'fnX').some(d => d.id === id7),
  'function query on normalized path hits',
)
assert.ok(
  decisionsForFunction(db, expectedFile, 'anyName').some(d => d.id === id7),
  'file-anchor reached via function query on normalized path',
)

// ── Scenario 8: file-kind anchor reachable via decisionsForFunction ──────
upsertNodes(db, [
  { file: 'src/x.ts', name: 'bar', kind: 'function', start_line: 1, end_line: 2 },
])
const id8 = createDecision(db, {
  decision: 'src/x.ts is the single source of truth',
  anchors: [{ kind: 'file', file: 'src/x.ts' }],
  keywords: ['source-of-truth'],
})
const fromFn = decisionsForFunction(db, 'src/x.ts', 'bar')
assert.ok(fromFn.some(d => d.id === id8), 'file-kind decision surfaces for any function in the file')

// ── Scenario 9: aggregation returns both function-level and file-level ──
upsertNodes(db, [
  { file: 'src/y.ts', name: 'foo2', kind: 'function', start_line: 1, end_line: 2 },
])
const idFn = createDecision(db, {
  decision: 'function-level on y::foo2',
  anchors: [{ kind: 'function', file: 'src/y.ts', name: 'foo2' }],
  keywords: ['fn-level'],
})
const idFile = createDecision(db, {
  decision: 'file-level on y',
  anchors: [{ kind: 'file', file: 'src/y.ts' }],
  keywords: ['file-level'],
})
const both = decisionsForFunction(db, 'src/y.ts', 'foo2')
const ids = both.map(d => d.id).sort((a, b) => a - b)
assert.deepEqual(ids, [idFn, idFile].sort((a, b) => a - b),
  'function query returns both function-level and file-level')

// ── Scenario 10: file-kind live semantics ────────────────────────────────
const id10 = createDecision(db, {
  decision: 'file with no nodes yet',
  anchors: [{ kind: 'file', file: 'src/empty.ts' }],
  keywords: ['live-semantics'],
})
const before10 = anchorsForDecision(db, id10)
assert.equal(before10[0].live, false, 'file anchor dead before any node exists')

upsertNodes(db, [
  { file: 'src/empty.ts', name: 'anything', kind: 'function', start_line: 1, end_line: 1 },
])
const after10 = anchorsForDecision(db, id10)
assert.equal(after10[0].live, true, 'file anchor live once any node in file exists')

// ── Scenario 11: CHECK constraint catches inconsistent rows ──────────────
const id11 = createDecision(db, {
  decision: 'dummy for raw-insert experiments',
  anchors: [{ kind: 'function', file: 'src/a.ts', name: 'foo' }],
  keywords: ['raw-insert'],
})
// function kind must have non-empty name
assert.throws(
  () => db.prepare(
    `INSERT INTO decision_anchors (decision_id, anchor_kind, anchor_file, anchor_name)
     VALUES (?, 'function', ?, '')`,
  ).run(id11, 'src/a.ts'),
  /CHECK constraint/,
  'function with empty name rejected',
)
// file kind must have empty name
assert.throws(
  () => db.prepare(
    `INSERT INTO decision_anchors (decision_id, anchor_kind, anchor_file, anchor_name)
     VALUES (?, 'file', ?, 'nonempty')`,
  ).run(id11, 'src/a.ts'),
  /CHECK constraint/,
  'file with non-empty name rejected',
)

// ── Scenario 12: vocabKeywords frequency ordering + tie-break + limit ────
{
  // Reset keyword corpus by deleting all decisions (cascade clears keywords)
  db.exec('DELETE FROM decisions')
  upsertNodes(db, [
    { file: 'src/v.ts', name: 'v', kind: 'function', start_line: 1, end_line: 1 },
  ])
  const mk = (kw: string[]): void => {
    createDecision(db, {
      decision: `vocab probe ${kw.join(',')}`,
      anchors: [{ kind: 'function', file: 'src/v.ts', name: 'v' }],
      keywords: kw,
    })
  }
  mk(['retry', 'fallback'])
  mk(['retry', 'session'])
  mk(['retry'])
  mk(['fallback'])
  mk(['session'])
  // counts: retry=3, fallback=2, session=2
  // expected order: retry, fallback, session (alphabetical tie-break for fallback < session)
  const all = vocabKeywords(db)
  assert.deepEqual(all, ['retry', 'fallback', 'session'], `vocab order: ${JSON.stringify(all)}`)

  const top2 = vocabKeywords(db, 2)
  assert.deepEqual(top2, ['retry', 'fallback'], `top2: ${JSON.stringify(top2)}`)
}

// ── Scenario 13: liveAnchorCount across batch ────────────────────────────
{
  db.exec('DELETE FROM decisions')
  upsertNodes(db, [
    { file: 'src/live.ts', name: 'alive', kind: 'function', start_line: 1, end_line: 1 },
  ])
  const idLive = createDecision(db, {
    decision: 'anchor on live node',
    anchors: [{ kind: 'function', file: 'src/live.ts', name: 'alive' }],
    keywords: ['live-test'],
  })
  const idDead = createDecision(db, {
    decision: 'anchor on missing node',
    anchors: [{ kind: 'function', file: 'src/live.ts', name: 'missing' }],
    keywords: ['live-test'],
  })
  const stats = liveAnchorCount(db, [idLive, idDead])
  assert.equal(stats.total, 2)
  assert.equal(stats.live, 1, `expected 1 live got ${stats.live}`)

  assert.deepEqual(liveAnchorCount(db, []), { live: 0, total: 0 })
}

closeDatabase(db)
cleanup()
console.log('OK')
