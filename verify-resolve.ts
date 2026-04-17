import * as fs from 'fs'
import * as path from 'path'
import assert from 'node:assert/strict'
import { resolveImport } from './src/resolve-imports'
import { resolveCall, buildRegistry, ResolverImport, Registry } from './src/resolve'

const ROOT = '/tmp/ctx-resolve-test'

function setupFixture(): void {
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(path.join(ROOT, 'src', 'b'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'src', 'a.ts'), '')
  fs.writeFileSync(path.join(ROOT, 'src', 'd.ts'), '')
  fs.writeFileSync(path.join(ROOT, 'src', 'b', 'index.ts'), '')
  fs.writeFileSync(path.join(ROOT, 'src', 'b', 'c.ts'), '')
  fs.writeFileSync(path.join(ROOT, 'src', 'b', 'mod.mjs'), '')
}

function tearDown(): void {
  fs.rmSync(ROOT, { recursive: true, force: true })
}

function namedImport(local: string, imported: string, resolved: string | null): ResolverImport {
  return { local_name: local, imported_name: imported, is_default: false, is_namespace: false, resolved_file: resolved }
}

function defaultImport(local: string, resolved: string): ResolverImport {
  return { local_name: local, imported_name: 'default', is_default: true, is_namespace: false, resolved_file: resolved }
}

function namespaceImport(local: string, resolved: string): ResolverImport {
  return { local_name: local, imported_name: '*', is_default: false, is_namespace: true, resolved_file: resolved }
}

setupFixture()

// ── Import resolver (5 scenarios) ────────────────────────────────────────

// 1. Relative TS resolves
assert.deepEqual(
  resolveImport('./a', 'src/app.ts', ROOT),
  { kind: 'resolved', path: 'src/a.ts' },
)

// 2. Directory index resolves
assert.deepEqual(
  resolveImport('./b', 'src/app.ts', ROOT),
  { kind: 'resolved', path: 'src/b/index.ts' },
)

// 3. Nested relative resolves
assert.deepEqual(
  resolveImport('./c', 'src/b/other.ts', ROOT),
  { kind: 'resolved', path: 'src/b/c.ts' },
)

// 4. Missing relative is external
assert.deepEqual(
  resolveImport('./nope', 'src/app.ts', ROOT),
  { kind: 'external' },
)

// 5. Bare module is external
assert.deepEqual(
  resolveImport('lodash', 'src/app.ts', ROOT),
  { kind: 'external' },
)

// 15. .mjs extension resolves
assert.deepEqual(
  resolveImport('./mod', 'src/b/other.ts', ROOT),
  { kind: 'resolved', path: 'src/b/mod.mjs' },
)

// ── Call resolver (9 scenarios) ──────────────────────────────────────────

const baseRegistry: Registry = buildRegistry([
  { id: 1, file: 'src/a.ts', name: 'formatName' },
  { id: 2, file: 'src/a.ts', name: 'helper' },
  { id: 3, file: 'src/app.ts', name: 'createOrder' },
])

// 6. Named import resolves
{
  const r = resolveCall('formatName', 'src/app.ts', [namedImport('formatName', 'formatName', 'src/a.ts')], baseRegistry)
  assert.equal(r, 1)
}

// 7. Aliased named import resolves
{
  const r = resolveCall('fn', 'src/app.ts', [namedImport('fn', 'formatName', 'src/a.ts')], baseRegistry)
  assert.equal(r, 1)
}

// 8. Same-module resolves
{
  const r = resolveCall('createOrder', 'src/app.ts', [], baseRegistry)
  assert.equal(r, 3)
}

// 9. Strategy 1 takes precedence over strategy 2
{
  const collisionReg = buildRegistry([
    { id: 1, file: 'src/a.ts', name: 'formatName' },
    { id: 99, file: 'src/app.ts', name: 'formatName' },
  ])
  const r = resolveCall('formatName', 'src/app.ts', [namedImport('formatName', 'formatName', 'src/a.ts')], collisionReg)
  assert.equal(r, 1, 'imported target wins over same-file collision')
}

// 10. Member chain classified as member_chain
{
  const r = resolveCall('obj.method', 'src/app.ts', [], baseRegistry)
  assert.deepEqual(r, { unresolved: 'member_chain' })
}

// 11. Default import classified as default_import (does NOT fall through to same-file 77)
{
  const reg = buildRegistry([
    { id: 77, file: 'src/app.ts', name: 'X' },
    { id: 42, file: 'src/logger.ts', name: 'log' },
  ])
  const r = resolveCall('X', 'src/app.ts', [defaultImport('X', 'src/logger.ts')], reg)
  assert.deepEqual(r, { unresolved: 'default_import' }, 'internal default import: class as default_import, not same-file 77')
}

// 12. Namespace import classified as namespace_import (does NOT fall through to same-file 66)
{
  const reg = buildRegistry([
    { id: 66, file: 'src/app.ts', name: 'utils' },
  ])
  const r = resolveCall('utils', 'src/app.ts', [namespaceImport('utils', 'src/a.ts')], reg)
  assert.deepEqual(r, { unresolved: 'namespace_import' })
}

// 13. External named import classified as external (does NOT fall through to same-file 88)
{
  const reg = buildRegistry([
    { id: 88, file: 'src/app.ts', name: 'axios' },
  ])
  const r = resolveCall('axios', 'src/app.ts', [namedImport('axios', 'axios', null)], reg)
  assert.deepEqual(r, { unresolved: 'external' })
}

// 14. Barrel re-export classified as barrel_miss (v1 blind-spot pin)
{
  const reg = buildRegistry([
    { id: 3, file: 'src/app.ts', name: 'createOrder' },
    // src/utils/index.ts deliberately has no 'foo' — simulates barrel re-export
  ])
  const r = resolveCall('foo', 'src/app.ts', [namedImport('foo', 'foo', 'src/utils/index.ts')], reg)
  assert.deepEqual(r, { unresolved: 'barrel_miss' })
}

// 16. External default import goes to external, not default_import
//     (ordering pin — resolved_file === null is checked before is_default)
{
  const reg = buildRegistry([])
  const externalDefault: ResolverImport = {
    local_name: 'Parser', imported_name: 'default',
    is_default: true, is_namespace: false, resolved_file: null,
  }
  const r = resolveCall('Parser', 'src/app.ts', [externalDefault], reg)
  assert.deepEqual(r, { unresolved: 'external' }, 'external default import is external, not default_import')
}

// 17. Unknown bare (no import, no same-file match) classified as unknown_bare
{
  const r = resolveCall('setTimeout', 'src/app.ts', [], baseRegistry)
  assert.deepEqual(r, { unresolved: 'unknown_bare' })
}

tearDown()
console.log('OK')
