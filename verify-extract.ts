import assert from 'node:assert/strict'
import {
  initParser,
  extractFromFile,
  Language,
  ExtractedFunction,
  ExtractedImport,
} from './src/extract'

function oneFn(src: string, lang: Language = 'typescript'): ExtractedFunction {
  const r = extractFromFile(src, lang)
  assert.equal(r.functions.length, 1, `expected 1 function, got ${r.functions.length}: ${JSON.stringify(r.functions)}`)
  return r.functions[0]
}

function imports(src: string): ExtractedImport[] {
  return extractFromFile(src, 'typescript').imports
}

async function main() {
  // initParser idempotency: call twice, both resolve, second should be cheap
  await initParser()
  const t0 = Date.now()
  await initParser()
  const t1 = Date.now()
  assert.ok(t1 - t0 < 100, `second initParser should be near-instant, took ${t1 - t0}ms`)

  // 1. Simple function declaration
  {
    const f = oneFn('function foo() { bar() }')
    assert.equal(f.name, 'foo')
    assert.deepEqual(f.calls, ['bar'])
    assert.equal(f.start_line, 1)
  }

  // 2. Arrow assigned to const
  {
    const f = oneFn('const foo = () => { bar() }')
    assert.equal(f.name, 'foo')
    assert.deepEqual(f.calls, ['bar'])
  }

  // 3. Function expression assigned to const
  {
    const f = oneFn('const foo = function() { bar() }')
    assert.equal(f.name, 'foo')
    assert.deepEqual(f.calls, ['bar'])
  }

  // 4. Member chain calls
  {
    const f = oneFn('function f() { a.b.c(); x.y() }')
    assert.deepEqual(f.calls, ['a.b.c', 'x.y'])
  }

  // 5. new expression
  {
    const f = oneFn('function f() { new Foo() }')
    assert.deepEqual(f.calls, ['Foo'])
  }

  // 6. Chain break — post-order: inner call before outer
  {
    const f = oneFn('function f() { getUser().save() }')
    assert.deepEqual(f.calls, ['getUser', 'save'])
  }

  // 7. Duplicate calls preserved
  {
    const f = oneFn('function f() { a(); a(); a() }')
    assert.deepEqual(f.calls, ['a', 'a', 'a'])
  }

  // 8. Lambda calls attributed to enclosing named function (option c)
  //    See doc/lambda-attribution.md. Inline arrow callbacks walk into, not past.
  {
    const f = oneFn('function outer() { items.map(item => validate(item)) }')
    assert.deepEqual(f.calls, ['validate', 'items.map'], 'validate is attributed to outer; post-order so inner call comes first')
  }

  // 8b. Nested named function declaration is still a boundary
  {
    const f = oneFn('function outer() { function inner() { bar() }; inner() }')
    assert.deepEqual(f.calls, ['inner'], 'calls inside nested named function do not bubble up')
  }

  // 8c. Transaction-style callback (the dogfood motivating case)
  {
    const f = oneFn('function indexRepo() { db.transaction(() => { writeGraph() })() }')
    assert.ok(f.calls.includes('writeGraph'), 'writeGraph inside transaction callback is attributed to indexRepo')
  }

  // 9. Top-level calls dropped
  {
    const r = extractFromFile('const x = loadConfig(); function f() { use(x) }', 'typescript')
    assert.equal(r.functions.length, 1)
    assert.equal(r.functions[0].name, 'f')
    assert.deepEqual(r.functions[0].calls, ['use'])
    const allCalls = r.functions.flatMap(fn => fn.calls)
    assert.ok(!allCalls.includes('loadConfig'), 'loadConfig must not appear anywhere')
  }

  // 10. 1-indexed line numbers
  {
    const f = oneFn('function topLine() { noop() }')
    assert.equal(f.start_line, 1, 'first-line function has start_line 1, not 0')
  }

  // 11. TSX with real call
  {
    const f = oneFn('function App() { useEffect(); return <div /> }', 'tsx')
    assert.equal(f.name, 'App')
    assert.deepEqual(f.calls, ['useEffect'])
  }

  // 12. Named imports
  {
    const i = imports(`import { foo, bar } from './a'`)
    assert.equal(i.length, 2)
    assert.deepEqual(i.map(x => x.imported_name), ['foo', 'bar'])
    assert.ok(i.every(x => x.module_specifier === './a' && !x.is_default && !x.is_namespace))
  }

  // 13. Default import
  {
    const i = imports(`import X from './a'`)
    assert.equal(i.length, 1)
    assert.equal(i[0].local_name, 'X')
    assert.equal(i[0].imported_name, 'default')
    assert.ok(i[0].is_default)
  }

  // 14. Namespace import
  {
    const i = imports(`import * as X from './a'`)
    assert.equal(i.length, 1)
    assert.equal(i[0].local_name, 'X')
    assert.equal(i[0].imported_name, '*')
    assert.ok(i[0].is_namespace)
  }

  // 15. Default + named mixed
  {
    const i = imports(`import X, { a, b } from './c'`)
    assert.equal(i.length, 3)
    const defaults = i.filter(x => x.is_default)
    const named = i.filter(x => !x.is_default && !x.is_namespace)
    assert.equal(defaults.length, 1)
    assert.equal(named.length, 2)
    assert.equal(defaults[0].local_name, 'X')
    assert.deepEqual(named.map(x => x.imported_name).sort(), ['a', 'b'])
  }

  // 16. Alias in named import
  {
    const i = imports(`import { foo as bar } from './a'`)
    assert.equal(i.length, 1)
    assert.equal(i[0].local_name, 'bar')
    assert.equal(i[0].imported_name, 'foo')
  }

  // 17. Parse failure tolerance — shape contract
  {
    const r = extractFromFile('function broken( {', 'typescript')
    assert.ok(Array.isArray(r.functions), 'functions is array')
    assert.ok(Array.isArray(r.imports), 'imports is array')
  }

  // 18. Optional chain call
  {
    const f = oneFn('function f() { user?.profile?.save() }')
    assert.deepEqual(f.calls, ['user.profile.save'])
  }

  // 19. Computed-access call is skipped
  {
    const f = oneFn('function f() { a[b]() }')
    assert.deepEqual(f.calls, [])
  }

  // 20. Type-only whole statement: import is dropped, local function wins
  {
    const src = `import type { Foo } from './a'\nfunction Foo() { bar() }\nfunction caller() { Foo() }`
    const r = extractFromFile(src, 'typescript')
    assert.equal(r.imports.length, 0, 'import type { Foo } must not produce an ExtractedImport')
    const names = r.functions.map(f => f.name).sort()
    assert.deepEqual(names, ['Foo', 'caller'])
  }

  // 21. Inline type specifier: that specifier dropped, others kept
  {
    const i = imports(`import { type Foo, Bar } from './a'`)
    assert.equal(i.length, 1, 'only Bar should survive')
    assert.equal(i[0].imported_name, 'Bar')
  }

  // 22. Duplicate function names: keep first, report the rest
  {
    const src = `function foo() { helperA() }\nfunction foo() { helperB() }`
    const r = extractFromFile(src, 'javascript')
    assert.equal(r.functions.length, 1, 'dedup keeps only one')
    assert.equal(r.functions[0].name, 'foo')
    assert.deepEqual(r.functions[0].calls, ['helperA'], 'kept function is the first occurrence')
    assert.deepEqual(r.duplicateFunctionNames, ['foo'])
  }

  // 23. hadParseErrors flag on syntactically broken source
  {
    const r = extractFromFile('function broken( {', 'typescript')
    assert.equal(r.hadParseErrors, true, 'tree-sitter reported ERROR nodes')
    const clean = extractFromFile('function good() {}', 'typescript')
    assert.equal(clean.hadParseErrors, false, 'clean source has no parse errors')
  }

  console.log('OK')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
