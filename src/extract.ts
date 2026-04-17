import Parser from 'web-tree-sitter'
import * as path from 'path'
import { walkForImports } from './extract-imports'

type TsNode = Parser.SyntaxNode

export type Language = 'typescript' | 'tsx' | 'javascript'

export interface ExtractedFunction {
  name: string
  start_line: number
  end_line: number
  calls: string[]
}

export interface ExtractedImport {
  local_name: string
  imported_name: string
  module_specifier: string
  is_default: boolean
  is_namespace: boolean
}

export interface ExtractResult {
  functions: ExtractedFunction[]
  imports: ExtractedImport[]
  hadParseErrors: boolean
  duplicateFunctionNames: string[]
}

let parsers: { typescript: Parser; tsx: Parser; javascript: Parser } | null = null
let initPromise: Promise<void> | null = null

export function initParser(): Promise<void> {
  if (parsers) return Promise.resolve()
  if (initPromise) return initPromise
  initPromise = loadParsers()
  return initPromise
}

async function loadParsers(): Promise<void> {
  await Parser.init()
  const wasmDir = path.join(
    path.dirname(require.resolve('tree-sitter-wasms/package.json')),
    'out',
  )
  const [ts, tsx, js] = await Promise.all([
    Parser.Language.load(path.join(wasmDir, 'tree-sitter-typescript.wasm')),
    Parser.Language.load(path.join(wasmDir, 'tree-sitter-tsx.wasm')),
    Parser.Language.load(path.join(wasmDir, 'tree-sitter-javascript.wasm')),
  ])
  parsers = { typescript: makeParser(ts), tsx: makeParser(tsx), javascript: makeParser(js) }
}

function makeParser(lang: Parser.Language): Parser {
  const p = new Parser()
  p.setLanguage(lang)
  return p
}

export function extractFromFile(source: string, lang: Language): ExtractResult {
  if (!parsers) throw new Error('Call initParser() before extractFromFile()')
  const tree = parsers[lang].parse(source)
  if (!tree) {
    return { functions: [], imports: [], hadParseErrors: true, duplicateFunctionNames: [] }
  }
  try {
    const hadParseErrors = tree.rootNode.hasError
    const { deduped, duplicates } = dedupeByName(walkForFunctions(tree.rootNode))
    return {
      functions: deduped,
      imports: walkForImports(tree.rootNode),
      hadParseErrors,
      duplicateFunctionNames: duplicates,
    }
  } finally {
    tree.delete()
  }
}

function dedupeByName(fns: ExtractedFunction[]): { deduped: ExtractedFunction[]; duplicates: string[] } {
  const seen = new Set<string>()
  const deduped: ExtractedFunction[] = []
  const duplicates: string[] = []
  for (const fn of fns) {
    if (seen.has(fn.name)) duplicates.push(fn.name)
    else { seen.add(fn.name); deduped.push(fn) }
  }
  return { deduped, duplicates }
}

const FUNCTION_BOUNDARIES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'method_definition',
])

const FUNCTION_VALUE_TYPES = new Set([
  'arrow_function', 'function_expression', 'function', 'generator_function',
])

function walkForFunctions(root: TsNode): ExtractedFunction[] {
  const out: ExtractedFunction[] = []
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)
    if (child) extractTopLevelFunction(child, out)
  }
  return out
}

function extractTopLevelFunction(node: TsNode, out: ExtractedFunction[]): void {
  if (node.type === 'export_statement') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child) extractTopLevelFunction(child, out)
    }
    return
  }
  if (node.type === 'function_declaration' || node.type === 'generator_function_declaration') {
    const nameNode = node.childForFieldName('name')
    const body = node.childForFieldName('body')
    if (nameNode && body) out.push(makeExtracted(nameNode.text, node, body))
    return
  }
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (!child || child.type !== 'variable_declarator') continue
      const nameNode = child.childForFieldName('name')
      const value = child.childForFieldName('value')
      if (!nameNode || !value || !FUNCTION_VALUE_TYPES.has(value.type)) continue
      const body = value.childForFieldName('body')
      if (body) out.push(makeExtracted(nameNode.text, child, body))
    }
  }
}

function makeExtracted(name: string, range: TsNode, body: TsNode): ExtractedFunction {
  return {
    name,
    start_line: range.startPosition.row + 1,
    end_line: range.endPosition.row + 1,
    calls: collectCalls(body),
  }
}

function collectCalls(body: TsNode): string[] {
  const nodes: TsNode[] = []
  walkCallsPostOrder(body, nodes, true)
  const calls: string[] = []
  for (const c of nodes) {
    const callee = c.type === 'new_expression'
      ? c.childForFieldName('constructor')
      : c.childForFieldName('function')
    if (!callee) continue
    const rendered = renderMemberChain(callee)
    if (rendered !== null) calls.push(rendered)
  }
  return calls
}

function walkCallsPostOrder(node: TsNode, out: TsNode[], isRoot: boolean): void {
  if (!isRoot && FUNCTION_BOUNDARIES.has(node.type)) return
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child) walkCallsPostOrder(child, out, false)
  }
  if (node.type === 'call_expression' || node.type === 'new_expression') out.push(node)
}

function renderMemberChain(node: TsNode): string | null {
  if (node.type === 'identifier' || node.type === 'property_identifier') return node.text
  if (node.type === 'member_expression') {
    const obj = node.childForFieldName('object')
    const prop = node.childForFieldName('property')
    if (!obj || !prop) return null
    if (obj.type === 'call_expression') return prop.text
    const objStr = renderMemberChain(obj)
    return objStr === null ? null : objStr + '.' + prop.text
  }
  return null
}
