/**
 * ai/budget.ts
 *
 * Token budget management. Pipeline checks after each LLM call.
 *
 * 用法：
 *   --budget 500000      Absolute: max 500K tokens
 *   --budget 50%         Percentage: 50% of remaining API quota (requires check-quota)
 */

import { TokenUsage, RateLimitInfo } from './types'

export class BudgetManager {
  private maxTokens: number
  private consumed: number = 0

  constructor(maxTokens: number) {
    this.maxTokens = maxTokens
  }

  /** Record usage from one call */
  record(usage: TokenUsage): void {
    this.consumed += usage.input_tokens + usage.output_tokens
  }

  /** Whether budget is exceeded */
  get exceeded(): boolean {
    return this.consumed >= this.maxTokens
  }

  /** Remaining tokens */
  get remaining(): number {
    return Math.max(0, this.maxTokens - this.consumed)
  }

  /** Percent used */
  get percentUsed(): number {
    return this.maxTokens > 0 ? Math.round((this.consumed / this.maxTokens) * 100) : 0
  }

  /** Tokens consumed */
  get used(): number {
    return this.consumed
  }

  /** Format usage summary */
  summary(): string {
    return `${formatTokens(this.consumed)} / ${formatTokens(this.maxTokens)} (${this.percentUsed}%)`
  }
}

/**
 * 解析 --budget 参数。
 * 返回 BudgetManager 或 null（无预算限制）。
 *
 * @param budgetStr "500000" 或 "50%"
 * @param rateLimit 当前 rate limit 信息（百分比模式需要）
 */
export function parseBudget(budgetStr: string | null, rateLimit?: RateLimitInfo): BudgetManager | null {
  if (!budgetStr) return null

  if (budgetStr.endsWith('%')) {
    const pct = parseInt(budgetStr.slice(0, -1))
    if (isNaN(pct) || pct <= 0 || pct > 100) {
      console.warn(`⚠️ Invalid budget percentage: ${budgetStr}, ignoring`)
      return null
    }
    if (!rateLimit || rateLimit.tokensRemaining <= 0) {
      console.warn(`⚠️ Cannot get remaining quota, percentage budget unavailable. Use absolute value (e.g. --budget 500000)`)
      return null
    }
    const maxTokens = Math.floor(rateLimit.tokensRemaining * (pct / 100))
    console.log(`📊 预算: 剩余额度 ${formatTokens(rateLimit.tokensRemaining)} 的 ${pct}% = ${formatTokens(maxTokens)}`)
    return new BudgetManager(maxTokens)
  }

  const maxTokens = parseInt(budgetStr)
  if (isNaN(maxTokens) || maxTokens <= 0) {
    console.warn(`⚠️ Invalid budget value: ${budgetStr}, ignoring`)
    return null
  }

  console.log(`📊 预算: ${formatTokens(maxTokens)}`)
  return new BudgetManager(maxTokens)
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return `${n}`
}
