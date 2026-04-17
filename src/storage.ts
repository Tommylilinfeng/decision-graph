import Database from 'better-sqlite3'

export type Db = Database.Database

export type NodeKind = 'function'
export type EdgeKind = 'calls'

export interface NodeInput {
  file: string
  name: string
  kind: NodeKind
  start_line: number
  end_line: number
}

export interface Node extends NodeInput {
  id: number
}

export interface EdgeInput {
  source_id: number
  target_id: number
  kind: EdgeKind
}

export interface Edge extends EdgeInput {
  count: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file       TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('function')),
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  UNIQUE (file, name)
);

CREATE TABLE IF NOT EXISTS edges (
  source_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind      TEXT    NOT NULL CHECK (kind IN ('calls')),
  count     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (source_id, target_id, kind)
);

CREATE TABLE IF NOT EXISTS decisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  decision   TEXT    NOT NULL,
  session_id TEXT,
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_anchors (
  decision_id INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  anchor_kind TEXT    NOT NULL CHECK (anchor_kind IN ('function', 'file')),
  anchor_file TEXT    NOT NULL,
  anchor_name TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (decision_id, anchor_kind, anchor_file, anchor_name),
  CHECK (
    (anchor_kind = 'function' AND anchor_name != '') OR
    (anchor_kind = 'file'     AND anchor_name = '')
  )
);

CREATE TABLE IF NOT EXISTS decision_keywords (
  decision_id INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  keyword     TEXT    NOT NULL,
  PRIMARY KEY (decision_id, keyword)
);

CREATE INDEX IF NOT EXISTS idx_nodes_name              ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_file              ON nodes(file);
CREATE INDEX IF NOT EXISTS idx_edges_source            ON edges(source_id, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target            ON edges(target_id, kind);
CREATE INDEX IF NOT EXISTS idx_decision_anchors_lookup ON decision_anchors(anchor_file, anchor_name);
CREATE INDEX IF NOT EXISTS idx_decision_keywords       ON decision_keywords(keyword);
`

export function openDatabase(path: string): Db {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}

export function closeDatabase(db: Db): void {
  db.close()
}

export function upsertNodes(db: Db, nodes: NodeInput[]): number[] {
  const stmt = db.prepare(`
    INSERT INTO nodes (file, name, kind, start_line, end_line)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (file, name) DO UPDATE SET
      start_line = excluded.start_line,
      end_line   = excluded.end_line
    RETURNING id
  `)
  const ids: number[] = []
  db.transaction(() => {
    for (const n of nodes) {
      const row = stmt.get(n.file, n.name, n.kind, n.start_line, n.end_line) as { id: number }
      ids.push(row.id)
    }
  })()
  return ids
}

export function insertEdges(db: Db, edges: EdgeInput[]): void {
  const stmt = db.prepare(`
    INSERT INTO edges (source_id, target_id, kind) VALUES (?, ?, ?)
    ON CONFLICT (source_id, target_id, kind)
    DO UPDATE SET count = count + 1
  `)
  db.transaction(() => {
    for (const e of edges) stmt.run(e.source_id, e.target_id, e.kind)
  })()
}

export function findNodeById(db: Db, id: number): Node | undefined {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Node | undefined
}

export function findNodesByName(db: Db, name: string): Node[] {
  return db.prepare('SELECT * FROM nodes WHERE name = ?').all(name) as Node[]
}

export function findNodesByFile(db: Db, file: string): Node[] {
  return db.prepare('SELECT * FROM nodes WHERE file = ?').all(file) as Node[]
}

export function findNodeAtLine(db: Db, file: string, line: number): Node | undefined {
  return db.prepare(`
    SELECT * FROM nodes
    WHERE file = ? AND start_line <= ? AND end_line >= ?
    ORDER BY (end_line - start_line) ASC
    LIMIT 1
  `).get(file, line, line) as Node | undefined
}

export function edgesFromNode(db: Db, source_id: number): Edge[] {
  return db.prepare(
    'SELECT source_id, target_id, kind, count FROM edges WHERE source_id = ?'
  ).all(source_id) as Edge[]
}

export function edgesToNode(db: Db, target_id: number): Edge[] {
  return db.prepare(
    'SELECT source_id, target_id, kind, count FROM edges WHERE target_id = ?'
  ).all(target_id) as Edge[]
}
