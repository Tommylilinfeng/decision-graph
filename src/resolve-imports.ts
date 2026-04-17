import * as fs from 'fs'
import * as path from 'path'

export type ResolvedImport =
  | { kind: 'resolved'; path: string }
  | { kind: 'external' }

const CANDIDATES = [
  (base: string) => base + '.ts',
  (base: string) => base + '.tsx',
  (base: string) => base + '.js',
  (base: string) => base + '.jsx',
  (base: string) => base + '.mjs',
  (base: string) => base + '.cjs',
  (base: string) => path.join(base, 'index.ts'),
  (base: string) => path.join(base, 'index.tsx'),
  (base: string) => path.join(base, 'index.js'),
  (base: string) => path.join(base, 'index.jsx'),
  (base: string) => path.join(base, 'index.mjs'),
  (base: string) => path.join(base, 'index.cjs'),
  (base: string) => base,
]

export function resolveImport(
  specifier: string,
  importingFile: string,
  projectRoot: string,
): ResolvedImport {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return { kind: 'external' }
  }
  const importerDir = path.dirname(path.resolve(projectRoot, importingFile))
  const base = path.resolve(importerDir, specifier)
  for (const make of CANDIDATES) {
    const abs = make(base)
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      return { kind: 'resolved', path: toPosix(path.relative(projectRoot, abs)) }
    }
  }
  return { kind: 'external' }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}
