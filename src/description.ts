import { Db } from './storage'
import { vocabKeywords } from './decisions'

const VOCAB_THRESHOLD = 100

export function buildDescription(db: Db): string {
  const all = vocabKeywords(db)
  const truncated = all.length > VOCAB_THRESHOLD
  const shown = truncated ? vocabKeywords(db, VOCAB_THRESHOLD) : all

  const parts = [
    'Record alerts for future AI working in this codebase.',
    '',
    'A "decision" flags a semantically important situation that grep cannot find. NOT documentation, NOT a TODO, NOT a bug note.',
    '',
    'RECORD when:',
    '- implicit ordering: "must call init() before read()"',
    '- historical landmines: "retry=1 intentional, was 3 — see incident 2025-03"',
    '- cross-file coupling: "output format must match src/api.ts schema"',
    '- intentional absence: "no validation here; middleware does it upstream"',
    '- non-obvious distinction: "foo() and bar() look duplicate but own different state"',
    '- temporal state: "v1 fallback exists, remove after Q3 migration"',
    '',
    'DO NOT record:',
    '- things grep finds (PRAGMA, type signatures, literal values)',
    '- TODOs / refactor wishes (those are tasks)',
    '- bug notes (issue tracker)',
    '',
    'WRITING: one terse sentence. The alert is enough; future AI investigates.',
    '',
    'KEYWORDS: >=1 per decision. Group decisions semantically; need NOT appear in the decision text — use them for business concepts ("billing-flow") or cross-cutting topics ("retry"). Reuse existing keywords; introduce new only for genuinely new concepts.',
    '',
    'KEYWORD FORMAT: lowercase ASCII, start with letter, end with letter/digit, [a-z0-9-] in between, length 2-40. OK: "retry", "v1-fallback", "billing-flow". Rejected: "Retry", "retry!", "a", "abc-".',
    '',
    'ANCHORS: function-level for single-function situations; file-level for whole-file. v1 has no class/method/block — anchor those to the enclosing function. Paths repo-relative; POSIX or OS sep both accepted.',
  ]

  if (shown.length > 0) {
    parts.push(
      '',
      `EXISTING KEYWORDS (frequency desc${truncated ? `, top ${VOCAB_THRESHOLD} of ${all.length}` : ''}):`,
      shown.join(', '),
    )
  }

  return parts.join('\n')
}
