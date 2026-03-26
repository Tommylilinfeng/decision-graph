/**
 * ai/index.ts
 *
 * Factory: create AIProvider from config.
 */

export { AIProvider, AIProviderOptions, AIConfig, TokenUsage, RateLimitInfo, UnifiedRateLimitInfo } from './types'
export { ClaudeCLIProvider } from './claude-cli'
export { AnthropicAPIProvider } from './anthropic-api'
export { CodexCLIProvider } from './codex-cli'

import { AIProvider, AIConfig } from './types'
import { ClaudeCLIProvider } from './claude-cli'
import { AnthropicAPIProvider } from './anthropic-api'
import { CodexCLIProvider } from './codex-cli'

const DEFAULT_CONFIG: AIConfig = {
  provider: 'claude-cli',
}

export function createAIProvider(config?: AIConfig): AIProvider {
  const c = config ?? DEFAULT_CONFIG

  switch (c.provider) {
    case 'claude-cli':
      return new ClaudeCLIProvider(c)
    case 'anthropic-api':
      return new AnthropicAPIProvider(c)
    case 'codex-cli':
      return new CodexCLIProvider(c)
    default:
      throw new Error(`Unknown AI provider: ${(c as any).provider}`)
  }
}

/**
 * Run a batch of LLM calls with automatic session cleanup on completion.
 * All runners (run, group, localize) should use this instead of manual cleanup.
 */
export async function withAutoCleanup<T>(provider: AIProvider, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } finally {
    provider.cleanup()
  }
}
