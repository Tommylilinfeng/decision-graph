/**
 * ai/types.ts
 *
 * AIProvider interface definition.
 * All AI providers (claude -p, Anthropic API, etc.) implement this interface.
 */

export interface AIProviderOptions {
  timeoutMs?: number
}

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
}

export interface RateLimitInfo {
  tokensLimit: number
  tokensRemaining: number
  requestsLimit: number
  requestsRemaining: number
  resetAt: string
}

export interface AIProvider {
  /** Display name for logging */
  name: string

  /**
   * Send prompt, return raw string.
   * Caller handles JSON parsing — provider handles transport.
   */
  call(prompt: string, options?: AIProviderOptions): Promise<string>

  /** Token usage from last call */
  lastUsage: TokenUsage

  /** Cumulative token usage */
  totalUsage: TokenUsage

  /** Latest rate limit info (Anthropic API only) */
  rateLimit?: RateLimitInfo
}

/**
 * ckg.config.json 里 "ai" 段的类型。
 */
export interface AIConfig {
  provider: 'claude-cli' | 'anthropic-api'
  model?: string        // e.g. "claude-sonnet-4-20250514"
  apiKey?: string        // anthropic-api 需要，claude-cli 不需要
  maxTokens?: number     // anthropic-api 用，默认 4096
  embedding?: {
    provider: 'voyage'
    apiKey?: string     // 或 env VOYAGE_API_KEY
    model?: string      // 默认 voyage-3-lite
  }
}
