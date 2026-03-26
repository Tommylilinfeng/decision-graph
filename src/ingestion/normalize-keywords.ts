/**
 * ingestion/normalize-keywords.ts
 *
 * Building block: global keyword normalization.
 *
 * Loads all unique keywords from active decisions, one LLM call to find synonyms,
 * then adds canonical forms to decisions containing aliases.
 *
 * Should be called before connect-decisions — normalized keywords improve grouping accuracy.
 *
 * 用法：
 *   import { normalizeKeywords } from './normalize-keywords'
 *   const result = await normalizeKeywords(session, ai)
 */

import { Session } from 'neo4j-driver'
import { AIProvider } from '../ai'
import { buildKeywordNormalizationPrompt } from '../prompts/grouping'
import { parseJsonSafe } from './shared'

// ── Types ───────────────────────────────────────────────

export interface NormalizeKeywordsResult {
  /** Normalizations applied (one per alias→canonical) */
  normalized: number
  /** List of canonical terms */
  terms: string[]
  /** Total unique keywords in graph */
  totalUniqueKeywords: number
}

// ── Main ────────────────────────────────────────────────

/**
 * Global keyword normalization.
 *
 * 1. Load all unique keywords from active decisions
 * 2. Skip if fewer than 5 (not worth an LLM call)
 * 3. One LLM call → {canonical, aliases}[]
 * 4. Add canonical form to decisions containing aliases
 */
export async function normalizeKeywords(
  session: Session,
  ai: AIProvider,
  options?: { verbose?: boolean }
): Promise<NormalizeKeywordsResult> {
  const verbose = options?.verbose ?? true

  if (verbose) console.log('\n🏷️  Keyword normalization...')

  // 1. Load all unique keywords
  const kwResult = await session.run(
    `MATCH (d:DecisionContext {staleness: 'active'})
     WHERE d.keywords IS NOT NULL
     UNWIND d.keywords AS kw
     RETURN DISTINCT kw ORDER BY kw`
  )
  const allKeywords = kwResult.records.map(r => r.get('kw') as string)

  if (allKeywords.length < 5) {
    if (verbose) console.log(`  ○ Too few keywords (${allKeywords.length}), skipping`)
    return { normalized: 0, terms: [], totalUniqueKeywords: allKeywords.length }
  }

  if (verbose) console.log(`  📊 共 ${allKeywords.length}  unique keywords`)

  // 2. LLM 调用
  const prompt = buildKeywordNormalizationPrompt(allKeywords)
  const raw = await ai.call(prompt, { timeoutMs: 60000 })
  const normalizations = parseJsonSafe<{ canonical: string; aliases: string[] }[]>(raw, [])

  if (!Array.isArray(normalizations) || normalizations.length === 0) {
    if (verbose) console.log(`  ○ No normalization needed`)
    return { normalized: 0, terms: [], totalUniqueKeywords: allKeywords.length }
  }

  // 3. Apply normalizations
  let normalized = 0
  for (const norm of normalizations) {
    if (!norm.canonical || !Array.isArray(norm.aliases)) continue
    for (const alias of norm.aliases) {
      try {
        const updateResult = await session.run(
          `MATCH (d:DecisionContext)
           WHERE ANY(k IN d.keywords WHERE k = $alias)
             AND NOT ANY(k IN d.keywords WHERE k = $canonical)
           SET d.keywords = d.keywords + [$canonical]
           RETURN count(d) AS cnt`,
          { alias, canonical: norm.canonical }
        )
        const cnt = updateResult.records[0]?.get('cnt')
        const num = typeof cnt === 'number' ? cnt : cnt?.toNumber?.() ?? 0
        if (num > 0) normalized++
      } catch {}
    }
  }

  const terms = normalizations.map(n => n.canonical)
  if (verbose) {
    console.log(`  ✅ ${normalized}  normalizations applied`)
    console.log(`    Terms: ${terms.join(', ')}`)
  }

  return { normalized, terms, totalUniqueKeywords: allKeywords.length }
}
