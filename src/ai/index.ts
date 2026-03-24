/**
 * ai/index.ts
 *
 * Factory: create AIProvider from config.
 */

export { AIProvider, AIProviderOptions, AIConfig, TokenUsage, RateLimitInfo, UnifiedRateLimitInfo } from './types'
export { ClaudeCLIProvider } from './claude-cli'
export { AnthropicAPIProvider } from './anthropic-api'

import { AIProvider, AIConfig } from './types'
import { ClaudeCLIProvider } from './claude-cli'
import { AnthropicAPIProvider } from './anthropic-api'

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
    default:
      throw new Error(`Unknown AI provider: ${(c as any).provider}`)
  }
}
