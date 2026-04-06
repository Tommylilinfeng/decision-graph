/**
 * runners/test-scenarios.ts
 *
 * Test scenario discovery on specific entry points.
 *
 * Usage:
 *   npx ts-node src/runners/test-scenarios.ts
 *   npx ts-node src/runners/test-scenarios.ts --entry queryLoop --entry checkPermissionsAndCallTool
 */

import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { loadConfig } from '../config'
import { createAIProvider } from '../ai'
import { discoverScenarios } from '../ingestion/scenario-discovery'

const args = process.argv.slice(2)
const entries: string[] = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--entry' && args[i + 1]) entries.push(args[i + 1])
}

async function main(): Promise<void> {
  const config = loadConfig()
  const repoConfig = config.repos.find((r: any) => r.name === 'claudecode')!
  const ai = createAIProvider(config.ai as any)

  console.log(`\n🎬 Scenario Discovery`)
  console.log(`   Entries: ${entries.length > 0 ? entries.join(', ') : 'auto-detect (top 3)'}`)
  console.log(`   AI: ${ai.name}`)
  console.log()

  await verifyConnectivity()
  const session = await getSession()

  try {
    const result = await discoverScenarios({
      dbSession: session,
      ai,
      repo: 'claudecode',
      repoPath: repoConfig.path,
      outputDir: 'data/docs/claudecode/scenarios',
      entryPoints: entries.length > 0 ? entries : undefined,
      maxEntryPoints: 3,
      onProgress: (msg) => console.log(msg),
    })

    console.log(`\n━━━ Results ━━━`)
    console.log(`  Scenarios: ${result.scenarioCount}`)
    console.log(`  Tokens: ${result.tokens.toLocaleString()}`)
    console.log(`  Duration: ${(result.durationMs / 1000).toFixed(0)}s`)
    console.log(`  Output: data/docs/claudecode/scenarios/`)
  } finally {
    ai.cleanup()
    await session.close()
    await closeDriver()
  }
}

main().catch(err => { console.error('❌', err.message); process.exit(1) })
