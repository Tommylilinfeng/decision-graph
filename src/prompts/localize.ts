/**
 * prompts/localize.ts
 *
 * Build translation prompts for decision localization.
 */

export interface DecisionToTranslate {
  id: string
  summary: string
  content: string
}

const LOCALE_NAMES: Record<string, string> = {
  zh: 'Chinese (Simplified)',
  ja: 'Japanese',
  ko: 'Korean',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
}

export function buildTranslationPrompt(
  decisions: DecisionToTranslate[],
  locale: string,
): string {
  const langName = LOCALE_NAMES[locale] ?? locale

  const decisionsJson = JSON.stringify(
    decisions.map(d => ({ id: d.id, summary: d.summary, content: d.content })),
    null,
    2,
  )

  return `You are translating software design decision descriptions from English to ${langName}.

RULES:
1. Translate summary and content fields to natural, fluent ${langName}.
2. DO NOT translate: function names, variable names, file paths, class names, or any code identifier. Keep them exactly as-is (e.g., createOrder, handlePayment, orderStore.js).
3. DO NOT translate technical abbreviations commonly used in English in engineering contexts (API, SQL, REST, gRPC, Redis, Kafka, etc.).
4. Preserve the meaning and specificity of the original. Do not generalize or lose detail.
5. Keep the same tone: technical and concise.

DECISIONS TO TRANSLATE:
${decisionsJson}

Return ONLY a raw JSON array (no markdown, no backticks):
[
  {
    "id": "...",
    "summary_${locale}": "...",
    "content_${locale}": "..."
  }
]`
}

/** Rough character count for token estimation (~4 chars per token) */
export function estimateChars(decisions: DecisionToTranslate[]): number {
  return decisions.reduce((sum, d) => sum + (d.summary?.length ?? 0) + (d.content?.length ?? 0), 0)
}
