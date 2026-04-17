import * as fs from 'fs'
import * as path from 'path'

export function sessionStatePath(projectRoot: string, sessionId: string): string {
  return path.join(projectRoot, '.ctx', 'sessions', `${sessionId}.json`)
}

export function readShown(p: string): Set<number> {
  if (!fs.existsSync(p)) return new Set()
  const raw = fs.readFileSync(p, 'utf8')
  const parsed = JSON.parse(raw) as { shown_decision_ids: number[] }
  return new Set(parsed.shown_decision_ids)
}

export function writeShown(p: string, shown: Set<number>): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify({ shown_decision_ids: Array.from(shown) }))
}

function listStateFiles(projectRoot: string): string[] {
  const dir = path.join(projectRoot, '.ctx', 'sessions')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(n => n.endsWith('.json'))
    .map(n => path.join(dir, n))
}

export function wipeAllStateFiles(projectRoot: string): number {
  const files = listStateFiles(projectRoot)
  for (const f of files) {
    fs.writeFileSync(f, JSON.stringify({ shown_decision_ids: [] }))
  }
  return files.length
}

export function deleteState(projectRoot: string, sessionId: string, gcOlderThanMs: number): void {
  const named = sessionStatePath(projectRoot, sessionId)
  if (fs.existsSync(named)) fs.unlinkSync(named)
  const cutoff = Date.now() - gcOlderThanMs
  for (const f of listStateFiles(projectRoot)) {
    const stat = fs.statSync(f)
    if (stat.mtimeMs < cutoff) fs.unlinkSync(f)
  }
}
