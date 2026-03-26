/**
 * ai/codex-cli.ts
 *
 * AIProvider implementation: calls OpenAI Codex CLI via `codex exec`.
 * Uses ChatGPT subscription, no API key needed.
 */

import fs from 'fs'
import { exec } from 'child_process'
import { AIProvider, AIProviderOptions, AIConfig, TokenUsage } from './types'

export class CodexCLIProvider implements AIProvider {
  name = 'codex-cli'
  lastUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }
  totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }

  private model: string | undefined

  constructor(config: AIConfig) {
    this.model = config.model
  }

  cleanup(): void { /* no session files to clean */ }

  call(prompt: string, options?: AIProviderOptions): Promise<string> {
    const timeoutMs = options?.timeoutMs ?? 120000

    return new Promise((resolve, reject) => {
      const tmp = `/tmp/ckg-codex-${process.pid}-${Math.random().toString(36).slice(2)}.txt`
      fs.writeFileSync(tmp, prompt, 'utf-8')

      const modelFlag = this.model ? ` --model ${this.model}` : ''
      const cmd = `cat "${tmp}" | codex exec -${modelFlag} --full-auto`

      exec(cmd, {
        encoding: 'utf-8',
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        try { fs.unlinkSync(tmp) } catch {}

        if (err) {
          reject(new Error(`codex exec failed: ${err.message}`))
          return
        }

        // codex exec streams progress to stderr, final answer to stdout
        const raw = stdout.trim()
        if (!raw) {
          reject(new Error('codex exec returned empty output'))
          return
        }

        const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
        resolve(cleaned)
      })
    })
  }
}
