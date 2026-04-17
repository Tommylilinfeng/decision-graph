import Parser from 'web-tree-sitter'
import type { ExtractedImport } from './extract'

type TsNode = Parser.SyntaxNode

export function walkForImports(root: TsNode): ExtractedImport[] {
  const out: ExtractedImport[] = []
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)
    if (child && child.type === 'import_statement') collectImports(child, out)
  }
  return out
}

function collectImports(importNode: TsNode, out: ExtractedImport[]): void {
  if (hasTypeKeyword(importNode)) return
  const sourceNode = importNode.childForFieldName('source')
  if (!sourceNode) return
  const spec = stripQuotes(sourceNode.text)
  for (let i = 0; i < importNode.childCount; i++) {
    const clause = importNode.child(i)
    if (!clause || clause.type !== 'import_clause') continue
    for (let j = 0; j < clause.childCount; j++) {
      const sub = clause.child(j)
      if (sub) emitImport(sub, spec, out)
    }
  }
}

function hasTypeKeyword(node: TsNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)
    if (c && (c.type === 'type' || (!c.isNamed && c.text === 'type'))) return true
  }
  return false
}

function emitImport(sub: TsNode, spec: string, out: ExtractedImport[]): void {
  if (sub.type === 'identifier') {
    out.push({ local_name: sub.text, imported_name: 'default', module_specifier: spec, is_default: true, is_namespace: false })
  } else if (sub.type === 'namespace_import') {
    const ident = findChild(sub, 'identifier')
    if (ident) out.push({ local_name: ident.text, imported_name: '*', module_specifier: spec, is_default: false, is_namespace: true })
  } else if (sub.type === 'named_imports') {
    collectNamedImports(sub, spec, out)
  }
}

function collectNamedImports(namedImports: TsNode, spec: string, out: ExtractedImport[]): void {
  for (let i = 0; i < namedImports.childCount; i++) {
    const s = namedImports.child(i)
    if (!s || s.type !== 'import_specifier') continue
    if (hasTypeKeyword(s)) continue
    const nameNode = s.childForFieldName('name')
    const aliasNode = s.childForFieldName('alias')
    if (!nameNode) continue
    out.push({
      local_name: aliasNode ? aliasNode.text : nameNode.text,
      imported_name: nameNode.text,
      module_specifier: spec,
      is_default: false,
      is_namespace: false,
    })
  }
}

function findChild(node: TsNode, type: string): TsNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)
    if (c && c.type === type) return c
  }
  return null
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && (s[0] === "'" || s[0] === '"') && s[s.length - 1] === s[0]) {
    return s.slice(1, -1)
  }
  return s
}
