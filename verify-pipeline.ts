import * as fs from 'fs'
import * as path from 'path'
import assert from 'node:assert/strict'
import { indexRepo } from './src/pipeline'
import { openDatabase, closeDatabase, findNodesByFile } from './src/storage'

function makeFixture(dir: string, files: Record<string, string>): void {
  fs.rmSync(dir, { recursive: true, force: true })
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

async function main() {
  // ── Scenario 1: Happy path ─────────────────────────────────────────────
  {
    const dir = '/tmp/ctx-pipeline-test-1'
    makeFixture(dir, {
      'src/a.ts': `export function formatName(s: string) { return s }`,
      'src/b.ts': `import { formatName } from './a'\nexport function main() { formatName('x') }`,
    })
    const r = await indexRepo(dir)
    assert.equal(r.files, 2)
    assert.equal(r.functions, 2)
    assert.equal(r.calls, 1)
    assert.equal(r.resolved, 1)
    assert.equal(r.unresolved, 0)
    assert.equal(r.parseFailures.length, 0)

    const db = openDatabase(path.join(dir, '.ctx', 'graph.db'))
    const nodeCount = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c
    const edgeCount = (db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number }).c
    assert.equal(nodeCount, 2)
    assert.equal(edgeCount, 1)
    const edges = db.prepare('SELECT * FROM edges').all() as Array<{ kind: string }>
    assert.equal(edges[0].kind, 'calls')
    closeDatabase(db)
    cleanup(dir)
  }

  // ── Scenario 2: Re-index idempotency ───────────────────────────────────
  {
    const dir = '/tmp/ctx-pipeline-test-2'
    makeFixture(dir, {
      'src/a.ts': `export function formatName(s: string) { return s }`,
      'src/b.ts': `import { formatName } from './a'\nexport function main() { formatName('x') }`,
    })
    const r1 = await indexRepo(dir)
    const r2 = await indexRepo(dir)
    assert.equal(r1.files, r2.files)
    assert.equal(r1.functions, r2.functions)
    assert.equal(r1.calls, r2.calls)
    assert.equal(r1.resolved, r2.resolved)
    cleanup(dir)
  }

  // ── Scenario 3: Test file excluded ─────────────────────────────────────
  {
    const dir = '/tmp/ctx-pipeline-test-3'
    makeFixture(dir, {
      'src/a.ts': `export function alive() { return 1 }`,
      'src/main.test.ts': `export function dead() { return 2 }`,
    })
    await indexRepo(dir)
    const db = openDatabase(path.join(dir, '.ctx', 'graph.db'))
    assert.equal(findNodesByFile(db, 'src/main.test.ts').length, 0, 'test file must be excluded')
    assert.equal(findNodesByFile(db, 'src/a.ts').length, 1)
    closeDatabase(db)
    cleanup(dir)
  }

  // ── Scenario 4: .d.ts excluded ─────────────────────────────────────────
  {
    const dir = '/tmp/ctx-pipeline-test-4'
    makeFixture(dir, {
      'src/a.ts': `export function alive() { return 1 }`,
      'src/types.d.ts': `export function declared(): void`,
    })
    await indexRepo(dir)
    const db = openDatabase(path.join(dir, '.ctx', 'graph.db'))
    assert.equal(findNodesByFile(db, 'src/types.d.ts').length, 0, '.d.ts must be excluded')
    closeDatabase(db)
    cleanup(dir)
  }

  // ── Scenario 5: Empty repo ─────────────────────────────────────────────
  {
    const dir = '/tmp/ctx-pipeline-test-5'
    makeFixture(dir, {
      'node_modules/foo.ts': `function ignored() {}`,
      'dist/bar.ts': `function ignored() {}`,
    })
    const r = await indexRepo(dir)
    assert.equal(r.files, 0)
    assert.equal(r.functions, 0)
    assert.equal(r.calls, 0)
    assert.ok(fs.existsSync(path.join(dir, '.ctx', 'graph.db')), 'db file must be created')
    cleanup(dir)
  }

  // ── Scenario 6: Path separator is POSIX ────────────────────────────────
  {
    const dir = '/tmp/ctx-pipeline-test-6'
    makeFixture(dir, {
      'src/nested/deep/foo.ts': `export function deepFn() { return 1 }`,
    })
    await indexRepo(dir)
    const db = openDatabase(path.join(dir, '.ctx', 'graph.db'))
    const found = findNodesByFile(db, 'src/nested/deep/foo.ts')
    assert.equal(found.length, 1, 'lookup with forward slashes must succeed')
    assert.equal(found[0].name, 'deepFn')
    closeDatabase(db)
    cleanup(dir)
  }

  // ── Scenario 7: Unresolved count correctness ───────────────────────────
  {
    const dir = '/tmp/ctx-pipeline-test-7'
    makeFixture(dir, {
      'src/a.ts': `export function solo() { externalThing() }`,
    })
    const r = await indexRepo(dir)
    assert.ok(r.unresolved >= 1, 'must have at least one unresolved call')
    assert.equal(r.unresolved, r.calls - r.resolved, 'conservation: unresolved == calls - resolved')
    cleanup(dir)
  }

  // ── Scenario 8: Type-only import does not hijack local function ────────
  {
    const dir = '/tmp/ctx-pipeline-test-8'
    makeFixture(dir, {
      'src/types.ts': `export interface User { id: string }`,
      'src/make.ts':
        `import type { User } from './types'\n` +
        `function User() { return { id: 'x' } }\n` +
        `export function main() { User() }`,
    })
    const r = await indexRepo(dir)
    const db = openDatabase(path.join(dir, '.ctx', 'graph.db'))
    const userNodes = db.prepare(`SELECT * FROM nodes WHERE name = 'User' AND file = 'src/make.ts'`).all() as Array<{ id: number }>
    const mainNodes = db.prepare(`SELECT * FROM nodes WHERE name = 'main' AND file = 'src/make.ts'`).all() as Array<{ id: number }>
    assert.equal(userNodes.length, 1, 'local User function exists')
    assert.equal(mainNodes.length, 1)
    const edge = db.prepare(`SELECT * FROM edges WHERE source_id = ? AND target_id = ?`)
      .get(mainNodes[0].id, userNodes[0].id)
    assert.ok(edge, 'main → local User edge must exist; type-only import must not hijack')
    assert.equal(r.resolved, 1)
    closeDatabase(db)
    cleanup(dir)
  }

  // ── Scenario 10: Build-output directories excluded ─────────────────────
  {
    const dir = '/tmp/ctx-pipeline-test-10'
    makeFixture(dir, {
      'src/a.ts': `export function alive() { return 1 }`,
      '.next/server.ts': `export function dead() { return 2 }`,
      'coverage/report.ts': `export function dead() { return 3 }`,
      'out/gen.ts': `export function dead() { return 4 }`,
      '.turbo/cache.ts': `export function dead() { return 5 }`,
    })
    await indexRepo(dir)
    const db = openDatabase(path.join(dir, '.ctx', 'graph.db'))
    const dead = (db.prepare(`SELECT COUNT(*) as c FROM nodes WHERE name = 'dead'`).get() as { c: number }).c
    assert.equal(dead, 0, 'build-output directories must be excluded')
    assert.equal(findNodesByFile(db, 'src/a.ts').length, 1, 'real source still indexed')
    closeDatabase(db)
    cleanup(dir)
  }

  // ── Scenario 11: *.config.{ts,js,mjs,cjs} excluded ─────────────────────
  {
    const dir = '/tmp/ctx-pipeline-test-11'
    makeFixture(dir, {
      'src/a.ts': `export function alive() { return 1 }`,
      'vite.config.ts': `export default function config() { return {} }`,
      'next.config.js': `function config() { return {} }; module.exports = config`,
      'tailwind.config.mjs': `export default function tw() { return {} }`,
    })
    await indexRepo(dir)
    const db = openDatabase(path.join(dir, '.ctx', 'graph.db'))
    assert.equal(findNodesByFile(db, 'vite.config.ts').length, 0, 'vite.config.ts excluded')
    assert.equal(findNodesByFile(db, 'next.config.js').length, 0, 'next.config.js excluded')
    assert.equal(findNodesByFile(db, 'tailwind.config.mjs').length, 0, 'tailwind.config.mjs excluded')
    assert.equal(findNodesByFile(db, 'src/a.ts').length, 1, 'real source still indexed')
    closeDatabase(db)
    cleanup(dir)
  }

  // ── Scenario 9: JS duplicate function names surface as warnings ────────
  {
    const dir = '/tmp/ctx-pipeline-test-9'
    makeFixture(dir, {
      'src/legacy.js':
        `function foo() { helperA() }\n` +
        `function foo() { helperB() }\n`,
    })
    const r = await indexRepo(dir)
    assert.equal(r.duplicateWarnings.length, 1, 'one duplicate reported')
    assert.equal(r.duplicateWarnings[0].name, 'foo')
    assert.equal(r.duplicateWarnings[0].file, 'src/legacy.js')
    assert.equal(r.functions, 1, 'only one node kept (first occurrence)')
    cleanup(dir)
  }

  console.log('OK')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
