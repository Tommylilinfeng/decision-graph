import * as path from 'path'
import type { Db } from './storage'

export interface Decision {
  id: number
  decision: string
  session_id: string | null
  created_at: string
}

export type AnchorInput =
  | { kind: 'function'; file: string; name: string }
  | { kind: 'file';     file: string }

export type Anchor =
  | { kind: 'function'; file: string; name: string; live: boolean }
  | { kind: 'file';     file: string;               live: boolean }

export interface CreateDecisionInput {
  decision: string
  session_id?: string
  anchors: ReadonlyArray<AnchorInput>
  keywords: ReadonlyArray<string>
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

export function createDecision(db: Db, input: CreateDecisionInput): number {
  if (input.anchors.length === 0) {
    throw new Error('createDecision requires at least one anchor')
  }
  if (input.keywords.length === 0) {
    throw new Error('createDecision requires at least one keyword')
  }
  const insertDecision = db.prepare(`
    INSERT INTO decisions (decision, session_id, created_at)
    VALUES (?, ?, ?)
    RETURNING id
  `)
  const insertAnchor = db.prepare(`
    INSERT OR IGNORE INTO decision_anchors (decision_id, anchor_kind, anchor_file, anchor_name)
    VALUES (?, ?, ?, ?)
  `)
  const insertKeyword = db.prepare(`
    INSERT OR IGNORE INTO decision_keywords (decision_id, keyword)
    VALUES (?, ?)
  `)
  let id = -1
  db.transaction(() => {
    const row = insertDecision.get(
      input.decision,
      input.session_id ?? null,
      new Date().toISOString(),
    ) as { id: number }
    id = row.id
    for (const a of input.anchors) {
      const name = a.kind === 'function' ? a.name : ''
      insertAnchor.run(id, a.kind, toPosix(a.file), name)
    }
    for (const k of input.keywords) {
      insertKeyword.run(id, k)
    }
  })()
  return id
}

export function decisionsForFunction(db: Db, file: string, name: string): Decision[] {
  const f = toPosix(file)
  return db.prepare(`
    SELECT DISTINCT d.id, d.decision, d.session_id, d.created_at
    FROM decisions d
    JOIN decision_anchors a ON a.decision_id = d.id
    WHERE a.anchor_file = ?
      AND (
        (a.anchor_kind = 'function' AND a.anchor_name = ?)
        OR a.anchor_kind = 'file'
      )
    ORDER BY d.created_at DESC
  `).all(f, name) as Decision[]
}

export function anchorsForDecision(db: Db, decision_id: number): Anchor[] {
  const rows = db.prepare(`
    SELECT
      a.anchor_kind AS kind,
      a.anchor_file AS file,
      a.anchor_name AS name,
      CASE a.anchor_kind
        WHEN 'function' THEN EXISTS (
          SELECT 1 FROM nodes n WHERE n.file = a.anchor_file AND n.name = a.anchor_name
        )
        WHEN 'file' THEN EXISTS (
          SELECT 1 FROM nodes n WHERE n.file = a.anchor_file
        )
      END AS live_flag
    FROM decision_anchors a
    WHERE a.decision_id = ?
    ORDER BY a.anchor_kind, a.anchor_file, a.anchor_name
  `).all(decision_id) as Array<{ kind: 'function' | 'file'; file: string; name: string; live_flag: number }>
  return rows.map(r => {
    const live = r.live_flag === 1
    return r.kind === 'function'
      ? { kind: 'function', file: r.file, name: r.name, live }
      : { kind: 'file',     file: r.file,                live }
  })
}

export function vocabKeywords(db: Db, limit?: number): string[] {
  const sql = `
    SELECT keyword FROM decision_keywords
    GROUP BY keyword
    ORDER BY COUNT(*) DESC, keyword ASC
    ${limit !== undefined ? 'LIMIT ?' : ''}
  `
  const rows = limit !== undefined ? db.prepare(sql).all(limit) : db.prepare(sql).all()
  return (rows as Array<{ keyword: string }>).map(r => r.keyword)
}

export function decisionsForFile(db: Db, file: string): Decision[] {
  const f = toPosix(file)
  return db.prepare(`
    SELECT DISTINCT d.id, d.decision, d.session_id, d.created_at
    FROM decisions d
    JOIN decision_anchors a ON a.decision_id = d.id
    WHERE a.anchor_file = ?
    ORDER BY d.created_at DESC
  `).all(f) as Decision[]
}

export function decisionsByKeyword(db: Db, keyword: string): Decision[] {
  return db.prepare(`
    SELECT DISTINCT d.id, d.decision, d.session_id, d.created_at
    FROM decisions d
    JOIN decision_keywords k ON k.decision_id = d.id
    WHERE k.keyword = ?
    ORDER BY d.created_at DESC
  `).all(keyword) as Decision[]
}

export function keywordsForDecisions(db: Db, ids: number[]): Map<number, string[]> {
  if (ids.length === 0) return new Map()
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT decision_id, keyword
    FROM decision_keywords
    WHERE decision_id IN (${placeholders})
    ORDER BY decision_id, keyword
  `).all(...ids) as Array<{ decision_id: number; keyword: string }>
  const m = new Map<number, string[]>()
  for (const r of rows) {
    const arr = m.get(r.decision_id) ?? []
    arr.push(r.keyword)
    m.set(r.decision_id, arr)
  }
  return m
}

export function anchorsForDecisions(db: Db, ids: number[]): Map<number, Anchor[]> {
  if (ids.length === 0) return new Map()
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT
      a.decision_id AS decision_id,
      a.anchor_kind AS kind,
      a.anchor_file AS file,
      a.anchor_name AS name,
      CASE a.anchor_kind
        WHEN 'function' THEN EXISTS (
          SELECT 1 FROM nodes n WHERE n.file = a.anchor_file AND n.name = a.anchor_name
        )
        WHEN 'file' THEN EXISTS (
          SELECT 1 FROM nodes n WHERE n.file = a.anchor_file
        )
      END AS live_flag
    FROM decision_anchors a
    WHERE a.decision_id IN (${placeholders})
    ORDER BY a.decision_id, a.anchor_kind, a.anchor_file, a.anchor_name
  `).all(...ids) as Array<{ decision_id: number; kind: 'function' | 'file'; file: string; name: string; live_flag: number }>
  const m = new Map<number, Anchor[]>()
  for (const r of rows) {
    const live = r.live_flag === 1
    const anchor: Anchor = r.kind === 'function'
      ? { kind: 'function', file: r.file, name: r.name, live }
      : { kind: 'file', file: r.file, live }
    const arr = m.get(r.decision_id) ?? []
    arr.push(anchor)
    m.set(r.decision_id, arr)
  }
  return m
}

export function liveAnchorCount(db: Db, decision_ids: number[]): { live: number; total: number } {
  if (decision_ids.length === 0) return { live: 0, total: 0 }
  const placeholders = decision_ids.map(() => '?').join(',')
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE
        WHEN a.anchor_kind = 'function'
          THEN EXISTS (SELECT 1 FROM nodes n WHERE n.file = a.anchor_file AND n.name = a.anchor_name)
        ELSE EXISTS (SELECT 1 FROM nodes n WHERE n.file = a.anchor_file)
      END), 0) AS live
    FROM decision_anchors a
    WHERE a.decision_id IN (${placeholders})
  `).get(...decision_ids) as { total: number; live: number }
  return { live: row.live, total: row.total }
}
