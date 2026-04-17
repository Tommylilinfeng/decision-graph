import * as fs from 'fs'
import assert from 'node:assert/strict'
import {
  openDatabase, closeDatabase,
  upsertNodes, insertEdges,
  findNodeById, findNodesByName, findNodesByFile, findNodeAtLine,
  edgesFromNode, edgesToNode,
} from './src/storage'

const DB_PATH = '/tmp/ctx-verify.db'

function cleanup(): void {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + ext) } catch { /* ignore */ }
  }
}

cleanup()
const db = openDatabase(DB_PATH)

// ── Scenario 1: upsert, ids in order, findNodesByName / findNodesByFile ──
const ids1 = upsertNodes(db, [
  { file: 'a.ts', name: 'foo', kind: 'function', start_line: 1,  end_line: 5  },
  { file: 'a.ts', name: 'bar', kind: 'function', start_line: 10, end_line: 20 },
  { file: 'a.ts', name: 'baz', kind: 'function', start_line: 30, end_line: 40 },
])
assert.equal(ids1.length, 3)
assert.equal(new Set(ids1).size, 3, 'ids unique')

const foo = findNodesByName(db, 'foo')[0]
const bar = findNodesByName(db, 'bar')[0]
const baz = findNodesByName(db, 'baz')[0]
assert.equal(foo.id, ids1[0], 'ids[0] == foo.id (input order preserved)')
assert.equal(bar.id, ids1[1])
assert.equal(baz.id, ids1[2])

const fileNodes = findNodesByFile(db, 'a.ts')
assert.equal(fileNodes.length, 3, 'findNodesByFile returns all 3')

// ── Scenario 2: identity stable under cosmetic edit ──────────────────────
insertEdges(db, [
  { source_id: ids1[0], target_id: ids1[1], kind: 'calls' }, // foo → bar
  { source_id: ids1[1], target_id: ids1[2], kind: 'calls' }, // bar → baz
])

const ids2 = upsertNodes(db, [
  { file: 'a.ts', name: 'foo', kind: 'function', start_line: 2,  end_line: 6  },
  { file: 'a.ts', name: 'bar', kind: 'function', start_line: 11, end_line: 21 },
  { file: 'a.ts', name: 'baz', kind: 'function', start_line: 31, end_line: 41 },
])
assert.deepEqual(ids2, ids1, 'ids unchanged across line-shift upsert')

const fooAfter = findNodeById(db, ids1[0])
assert(fooAfter, 'foo still exists')
assert.equal(fooAfter.start_line, 2, 'start_line updated')
assert.equal(fooAfter.end_line, 6, 'end_line updated')

const out = edgesFromNode(db, ids1[0])
assert.equal(out.length, 1, 'foo→bar edge preserved')
assert.equal(out[0].target_id, ids1[1])

const incoming = edgesToNode(db, ids1[2])
assert.equal(incoming.length, 1, 'bar→baz edge preserved')
assert.equal(incoming[0].source_id, ids1[1])

// ── Scenario 3: duplicate edge increments count, does not add a row ──────
const before = edgesFromNode(db, ids1[0])
assert.equal(before.length, 1, 'foo→bar already exists once')
assert.equal(before[0].count, 1, 'initial count is 1')

insertEdges(db, [{ source_id: ids1[0], target_id: ids1[1], kind: 'calls' }])
const afterOne = edgesFromNode(db, ids1[0])
assert.equal(afterOne.length, 1, 'still one row after duplicate insert')
assert.equal(afterOne[0].count, 2, 'count incremented to 2')

// ── Scenario 3b: third insert lands on count = 3 ────────────────────────
insertEdges(db, [{ source_id: ids1[0], target_id: ids1[1], kind: 'calls' }])
assert.equal(edgesFromNode(db, ids1[0])[0].count, 3, 'count increments on every duplicate')

// ── Scenario 3c: batched duplicates in a single insertEdges call ────────
insertEdges(db, [
  { source_id: ids1[0], target_id: ids1[1], kind: 'calls' },
  { source_id: ids1[0], target_id: ids1[1], kind: 'calls' },
])
assert.equal(edgesFromNode(db, ids1[0])[0].count, 5, 'batch of 2 duplicates lifts count by 2')

// ── Scenario 4: findNodeAtLine flat ──────────────────────────────────────
const flatIds = upsertNodes(db, [
  { file: 'b.ts', name: 'flat', kind: 'function', start_line: 10, end_line: 20 },
])
const flatHit = findNodeAtLine(db, 'b.ts', 15)
assert(flatHit, 'flat hit')
assert.equal(flatHit.id, flatIds[0])

const outOfRange = findNodeAtLine(db, 'b.ts', 100)
assert.equal(outOfRange, undefined, 'out-of-range returns undefined')

// ── Scenario 5: findNodeAtLine nested — verifies ORDER BY ────────────────
const nestedIds = upsertNodes(db, [
  { file: 'c.ts', name: 'outer', kind: 'function', start_line: 10, end_line: 50 },
  { file: 'c.ts', name: 'inner', kind: 'function', start_line: 20, end_line: 30 },
])
const inner = findNodeAtLine(db, 'c.ts', 25)
assert(inner, 'inner hit at line 25')
assert.equal(inner.id, nestedIds[1], 'line 25 returns inner (shortest range)')

const outerOnly = findNodeAtLine(db, 'c.ts', 15)
assert(outerOnly, 'outer hit at line 15')
assert.equal(outerOnly.id, nestedIds[0], 'line 15 returns outer (only match)')

// ── Scenario 6: cascade delete ───────────────────────────────────────────
db.prepare('DELETE FROM nodes WHERE id = ?').run(ids1[1]) // delete bar
assert.equal(edgesFromNode(db, ids1[0]).length, 0, 'foo→bar cascaded')
assert.equal(edgesToNode(db, ids1[2]).length, 0, 'bar→baz cascaded')

// ── Scenario 7: close ────────────────────────────────────────────────────
closeDatabase(db)
cleanup()

console.log('OK')
