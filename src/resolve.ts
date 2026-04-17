export type Registry = Map<string, number>

export type UnresolvedReason =
  | 'member_chain'
  | 'external'
  | 'default_import'
  | 'namespace_import'
  | 'barrel_miss'
  | 'unknown_bare'

export type ResolveResult = number | { unresolved: UnresolvedReason }

export interface ResolverImport {
  local_name: string
  imported_name: string
  is_default: boolean
  is_namespace: boolean
  resolved_file: string | null
}

export function buildRegistry(
  nodes: ReadonlyArray<{ id: number; file: string; name: string }>,
): Registry {
  const m: Registry = new Map()
  for (const n of nodes) m.set(`${n.file}::${n.name}`, n.id)
  return m
}

export function resolveCall(
  callee: string,
  callerFile: string,
  callerImports: ReadonlyArray<ResolverImport>,
  registry: Registry,
): ResolveResult {
  if (callee.includes('.')) return { unresolved: 'member_chain' }

  const imp = callerImports.find(i => i.local_name === callee)
  if (imp) {
    if (imp.resolved_file === null) return { unresolved: 'external' }
    if (imp.is_namespace) return { unresolved: 'namespace_import' }
    if (imp.is_default) return { unresolved: 'default_import' }
    const id = registry.get(`${imp.resolved_file}::${imp.imported_name}`)
    return id !== undefined ? id : { unresolved: 'barrel_miss' }
  }

  const id = registry.get(`${callerFile}::${callee}`)
  return id !== undefined ? id : { unresolved: 'unknown_bare' }
}
