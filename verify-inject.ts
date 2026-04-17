import * as fs from 'fs'
import * as path from 'path'
import assert from 'node:assert/strict'
import { openDatabase, closeDatabase, upsertNodes } from './src/storage'
import { createDecision } from './src/decisions'
import { runInject } from './src/inject'
import { runClearShown, runDeleteState } from './src/cli'
import { sessionStatePath, readShown, writeShown } from './src/session'

const ROOT = '/tmp/ctx-verify-inject'
const SESSION = 'sess-1'

function cleanup(): void {
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* ignore */ }
}

function setup(): { db: ReturnType<typeof openDatabase>; dbPath: string } {
  cleanup()
  fs.mkdirSync(path.join(ROOT, '.ctx'), { recursive: true })
  const dbPath = path.join(ROOT, '.ctx', 'graph.db')
  const db = openDatabase(dbPath)
  return { db, dbPath }
}

function makeStdin(file: string, sessionId: string | undefined = SESSION, cwd: string = ROOT): string {
  const obj: Record<string, unknown> = {
    tool_name: 'Read',
    tool_input: { file_path: file },
    cwd,
    hook_event_name: 'PreToolUse',
  }
  if (sessionId !== undefined) obj.session_id = sessionId
  return JSON.stringify(obj)
}

function parseInjected(stdout: string): { additionalContext: string } {
  const obj = JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }
  return { additionalContext: obj.hookSpecificOutput.additionalContext }
}

// ── Scenario 1: 3 decisions, none shown → all in NEW ─────────────────────
{
  const { db } = setup()
  upsertNodes(db, [{ file: 'src/foo.ts', name: 'bar', kind: 'function', start_line: 1, end_line: 5 }])
  for (let i = 0; i < 3; i++) {
    createDecision(db, {
      decision: `d${i}`,
      anchors: [{ kind: 'function', file: 'src/foo.ts', name: 'bar' }],
      keywords: ['test'],
    })
  }
  closeDatabase(db)

  const r = runInject(makeStdin(path.join(ROOT, 'src/foo.ts')))
  assert.ok(r.stdout.length > 0)
  const inj = parseInjected(r.stdout)
  assert.ok(inj.additionalContext.includes('3 decisions on src/foo.ts'))
  assert.ok(inj.additionalContext.includes('NEW:'))
  assert.equal(r.stateAfter.size, 3)
}

// ── Scenario 2: all shown earlier → short hint ───────────────────────────
{
  const { db } = setup()
  upsertNodes(db, [{ file: 'src/foo.ts', name: 'bar', kind: 'function', start_line: 1, end_line: 5 }])
  const ids = [
    createDecision(db, { decision: 'd1', anchors: [{ kind: 'function', file: 'src/foo.ts', name: 'bar' }], keywords: ['t'] }),
    createDecision(db, { decision: 'd2', anchors: [{ kind: 'function', file: 'src/foo.ts', name: 'bar' }], keywords: ['t'] }),
  ]
  closeDatabase(db)
  writeShown(sessionStatePath(ROOT, SESSION), new Set(ids))

  const r = runInject(makeStdin(path.join(ROOT, 'src/foo.ts')))
  const inj = parseInjected(r.stdout)
  assert.ok(inj.additionalContext.includes('shown earlier'))
  assert.ok(!inj.additionalContext.includes('NEW:'))
  assert.ok(inj.additionalContext.includes('reset_decision_cache'))
}

// ── Scenario 3: mix new + shown ──────────────────────────────────────────
{
  const { db } = setup()
  upsertNodes(db, [{ file: 'src/foo.ts', name: 'bar', kind: 'function', start_line: 1, end_line: 5 }])
  const ids: number[] = []
  for (let i = 0; i < 5; i++) {
    ids.push(createDecision(db, {
      decision: `d${i}`,
      anchors: [{ kind: 'function', file: 'src/foo.ts', name: 'bar' }],
      keywords: ['t'],
    }))
  }
  closeDatabase(db)
  writeShown(sessionStatePath(ROOT, SESSION), new Set([ids[0], ids[1]]))

  const r = runInject(makeStdin(path.join(ROOT, 'src/foo.ts')))
  const inj = parseInjected(r.stdout)
  assert.ok(inj.additionalContext.includes('5 decisions on src/foo.ts (3 new, 2 shown earlier)'))
  assert.ok(inj.additionalContext.includes('2 decisions on this file already shown earlier'))
}

// ── Scenario 4: no decisions on file → empty stdout ──────────────────────
{
  const { db } = setup()
  upsertNodes(db, [{ file: 'src/other.ts', name: 'x', kind: 'function', start_line: 1, end_line: 5 }])
  closeDatabase(db)

  const r = runInject(makeStdin(path.join(ROOT, 'src/foo.ts')))
  assert.equal(r.stdout, '')
}

// ── Scenario 5: project not indexed → empty stdout ───────────────────────
{
  cleanup()
  fs.mkdirSync(ROOT, { recursive: true })
  const r = runInject(makeStdin(path.join(ROOT, 'src/foo.ts')))
  assert.equal(r.stdout, '')
}

// ── Scenario 6: file outside repo → empty stdout ─────────────────────────
{
  const { db } = setup()
  upsertNodes(db, [{ file: 'src/foo.ts', name: 'bar', kind: 'function', start_line: 1, end_line: 5 }])
  createDecision(db, { decision: 'd', anchors: [{ kind: 'file', file: 'src/foo.ts' }], keywords: ['t'] })
  closeDatabase(db)

  const r = runInject(makeStdin('/etc/hosts'))
  assert.equal(r.stdout, '')
}

// ── Scenario 7: cross-file dedupe ────────────────────────────────────────
{
  const { db } = setup()
  upsertNodes(db, [
    { file: 'src/a.ts', name: 'fa', kind: 'function', start_line: 1, end_line: 5 },
    { file: 'src/b.ts', name: 'fb', kind: 'function', start_line: 1, end_line: 5 },
  ])
  const sharedId = createDecision(db, {
    decision: 'cross-cutting',
    anchors: [
      { kind: 'function', file: 'src/a.ts', name: 'fa' },
      { kind: 'function', file: 'src/b.ts', name: 'fb' },
    ],
    keywords: ['cross'],
  })
  closeDatabase(db)

  const r1 = runInject(makeStdin(path.join(ROOT, 'src/a.ts')))
  assert.ok(r1.stateAfter.has(sharedId))

  const r2 = runInject(makeStdin(path.join(ROOT, 'src/b.ts')))
  const inj2 = parseInjected(r2.stdout)
  assert.ok(inj2.additionalContext.includes('shown earlier'),
    `b should show short hint since X already shown for a; got: ${inj2.additionalContext}`)
}

// ── Scenario 8: path normalization (windows-style separators) ────────────
{
  const { db } = setup()
  upsertNodes(db, [{ file: 'src/foo.ts', name: 'bar', kind: 'function', start_line: 1, end_line: 5 }])
  createDecision(db, {
    decision: 'd',
    anchors: [{ kind: 'function', file: 'src/foo.ts', name: 'bar' }],
    keywords: ['t'],
  })
  closeDatabase(db)

  const winPath = path.join(ROOT, 'src', 'foo.ts').split('/').join('\\')
  const r = runInject(makeStdin(winPath))
  if (r.stdout) {
    const inj = parseInjected(r.stdout)
    assert.ok(inj.additionalContext.includes('src/foo.ts'), 'POSIX path used in output')
  }
}

// ── Scenario 9: cap truncation ───────────────────────────────────────────
{
  const { db } = setup()
  upsertNodes(db, [{ file: 'src/big.ts', name: 'bar', kind: 'function', start_line: 1, end_line: 5 }])
  const longText = 'x'.repeat(300)
  for (let i = 0; i < 60; i++) {
    createDecision(db, {
      decision: `${i}-${longText}`,
      anchors: [{ kind: 'function', file: 'src/big.ts', name: 'bar' }],
      keywords: ['big'],
    })
  }
  closeDatabase(db)

  const r = runInject(makeStdin(path.join(ROOT, 'src/big.ts')))
  const inj = parseInjected(r.stdout)
  assert.ok(inj.additionalContext.length <= 8200, `expected ≤8200 chars, got ${inj.additionalContext.length}`)
  assert.ok(inj.additionalContext.includes('truncated'), 'truncation footer present')
  assert.equal(r.stateAfter.size, 60, 'all 60 decisions marked shown despite truncation')

  const r2 = runInject(makeStdin(path.join(ROOT, 'src/big.ts')))
  const inj2 = parseInjected(r2.stdout)
  assert.ok(inj2.additionalContext.includes('shown earlier'),
    'second Read should be short hint, no overflow re-injection')
}

// ── Scenario 10: state file mkdir on first write ─────────────────────────
{
  const { db } = setup()
  upsertNodes(db, [{ file: 'src/foo.ts', name: 'bar', kind: 'function', start_line: 1, end_line: 5 }])
  createDecision(db, {
    decision: 'd',
    anchors: [{ kind: 'function', file: 'src/foo.ts', name: 'bar' }],
    keywords: ['t'],
  })
  closeDatabase(db)
  // sessions dir does NOT exist yet
  assert.ok(!fs.existsSync(path.join(ROOT, '.ctx', 'sessions')))

  const r = runInject(makeStdin(path.join(ROOT, 'src/foo.ts')))
  assert.ok(r.stdout.length > 0)
  assert.ok(fs.existsSync(sessionStatePath(ROOT, SESSION)), 'state file created')
}

// ── Scenario 11: session_id missing → fallback _default ──────────────────
{
  const { db } = setup()
  upsertNodes(db, [{ file: 'src/foo.ts', name: 'bar', kind: 'function', start_line: 1, end_line: 5 }])
  createDecision(db, {
    decision: 'd',
    anchors: [{ kind: 'function', file: 'src/foo.ts', name: 'bar' }],
    keywords: ['t'],
  })
  closeDatabase(db)

  const stdinNoSession = JSON.stringify({
    tool_name: 'Read',
    tool_input: { file_path: path.join(ROOT, 'src/foo.ts') },
    cwd: ROOT,
    hook_event_name: 'PreToolUse',
  })
  const r = runInject(stdinNoSession)
  assert.ok(r.stdout.length > 0, 'inject produced output')
  assert.ok(fs.existsSync(sessionStatePath(ROOT, '_default')), 'fallback state file created')
}

// ── Scenario 12: keywords inline ─────────────────────────────────────────
{
  const { db } = setup()
  upsertNodes(db, [{ file: 'src/foo.ts', name: 'bar', kind: 'function', start_line: 1, end_line: 5 }])
  createDecision(db, {
    decision: 'with kw',
    anchors: [{ kind: 'function', file: 'src/foo.ts', name: 'bar' }],
    keywords: ['retry', 'fallback'],
  })
  closeDatabase(db)

  const r = runInject(makeStdin(path.join(ROOT, 'src/foo.ts')))
  const inj = parseInjected(r.stdout)
  assert.ok(inj.additionalContext.includes('[fallback, retry]') || inj.additionalContext.includes('[retry, fallback]'),
    `keyword list missing or unordered as expected; got: ${inj.additionalContext}`)
}

// ── Scenario 13: anchor grouping rule ────────────────────────────────────
{
  const { db } = setup()
  upsertNodes(db, [
    { file: 'src/x.ts', name: 'fn1', kind: 'function', start_line: 1, end_line: 5 },
    { file: 'src/x.ts', name: 'fn2', kind: 'function', start_line: 6, end_line: 10 },
  ])
  // decision A: file-level + fn1 → should appear ONCE under file-level
  createDecision(db, {
    decision: 'A-mixed',
    anchors: [
      { kind: 'file', file: 'src/x.ts' },
      { kind: 'function', file: 'src/x.ts', name: 'fn1' },
    ],
    keywords: ['t'],
  })
  // decision B: fn1 + fn2 → should appear under both fn sections
  createDecision(db, {
    decision: 'B-twofn',
    anchors: [
      { kind: 'function', file: 'src/x.ts', name: 'fn1' },
      { kind: 'function', file: 'src/x.ts', name: 'fn2' },
    ],
    keywords: ['t'],
  })
  closeDatabase(db)

  const r = runInject(makeStdin(path.join(ROOT, 'src/x.ts')))
  const inj = parseInjected(r.stdout)
  // A-mixed: exactly one occurrence
  assert.equal((inj.additionalContext.match(/A-mixed/g) ?? []).length, 1, 'A appears once')
  // A under file-level section
  const fileLevelIdx = inj.additionalContext.indexOf('file-level:')
  const aIdx = inj.additionalContext.indexOf('A-mixed')
  const fn1Idx = inj.additionalContext.indexOf('fn fn1():')
  assert.ok(fileLevelIdx >= 0 && aIdx > fileLevelIdx && (fn1Idx < 0 || aIdx < fn1Idx),
    `A should be under file-level, before any fn section`)
  // B-twofn: appears twice (under fn1 AND fn2)
  assert.equal((inj.additionalContext.match(/B-twofn/g) ?? []).length, 2, 'B appears twice')
}

// ── Scenario 14: CLI clear-shown wipes state for given session ───────────
{
  const { db } = setup()
  closeDatabase(db)
  writeShown(sessionStatePath(ROOT, SESSION), new Set([1, 2, 3]))

  runClearShown(JSON.stringify({ session_id: SESSION, cwd: ROOT }))
  const after = readShown(sessionStatePath(ROOT, SESSION))
  assert.equal(after.size, 0, 'state wiped to empty')
}

// ── Scenario 15: CLI delete-state happy ──────────────────────────────────
{
  const { db } = setup()
  closeDatabase(db)
  writeShown(sessionStatePath(ROOT, SESSION), new Set([1]))

  runDeleteState(JSON.stringify({ session_id: SESSION, cwd: ROOT }))
  assert.ok(!fs.existsSync(sessionStatePath(ROOT, SESSION)), 'named state file unlinked')
}

// ── Scenario 16: CLI delete-state GC older than 7 days ───────────────────
{
  const { db } = setup()
  closeDatabase(db)
  const a = sessionStatePath(ROOT, 'sess-a')
  const b = sessionStatePath(ROOT, 'sess-b-old')
  const c = sessionStatePath(ROOT, 'sess-c-recent')
  writeShown(a, new Set([1]))
  writeShown(b, new Set([2]))
  writeShown(c, new Set([3]))

  const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000
  fs.utimesSync(b, eightDaysAgo, eightDaysAgo)

  runDeleteState(JSON.stringify({ session_id: 'sess-a', cwd: ROOT }))
  assert.ok(!fs.existsSync(a), 'named (sess-a) deleted')
  assert.ok(!fs.existsSync(b), '8-day-old (sess-b-old) GCed')
  assert.ok(fs.existsSync(c), '1-day-old (sess-c-recent) kept')
}

cleanup()
console.log('OK')
