import { NextRequest } from 'next/server'
import { getProject, listRepos, updateProjectStatus } from '@/lib/db'
import { startProject, isProjectRunning, getProjectDir } from '@/lib/docker'
import { exec } from 'child_process'
import path from 'path'
import fs from 'fs'

export const dynamic = 'force-dynamic'
export const maxDuration = 600

const CKG_ROOT = path.resolve(process.cwd(), '..')
const JOERN = '/opt/homebrew/bin/joern'
const JOERN_PARSE = '/opt/homebrew/bin/joern-parse'
const JOERN_SCRIPT = path.join(CKG_ROOT, 'joern', 'extract-code-entities.sc')

function run(cmd: string, opts?: { env?: Record<string, string>; cwd?: string; timeout?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, {
      cwd: opts?.cwd ?? CKG_ROOT,
      encoding: 'utf-8',
      timeout: opts?.timeout ?? 300000,
      env: { ...process.env, ...opts?.env },
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.slice(0, 300) || err.message))
      else resolve(stdout)
    })
  })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const project = getProject(id)
  if (!project) {
    return new Response(JSON.stringify({ error: 'Project not found' }), { status: 404 })
  }

  const repos = listRepos(id)
  const portEnv = { CKG_MEMGRAPH_PORT: String(project.memgraph_port) }
  const projectDir = getProjectDir(project.id)
  const dataDir = path.join(projectDir, 'data')
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

  const encoder = new TextEncoder()
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()

  async function send(step: string, status: string, message: string, progress?: number) {
    const data = JSON.stringify({ step, status, message, progress })
    await writer.write(encoder.encode(`data: ${data}\n\n`))
  }

  ;(async () => {
    try {
      // ── Step 1: Start Memgraph ─────────────
      await send('docker', 'running', 'Starting Memgraph container...')

      if (isProjectRunning(project)) {
        await send('docker', 'done', `Memgraph already running (port ${project.memgraph_port})`)
      } else {
        const result = startProject(project)
        if (!result.success) {
          await send('docker', 'error', `Failed to start: ${result.message}`)
          await send('complete', 'error', 'Initialization aborted')
          await writer.close()
          return
        }
        await send('docker', 'running', 'Waiting for Memgraph to be ready...')
        await new Promise(r => setTimeout(r, 10000))
        updateProjectStatus(id, 'running')
        await send('docker', 'done', `Memgraph started (port ${project.memgraph_port})`)
      }

      // ── Step 2: Schema ─────────────────────
      await send('schema', 'running', 'Initializing graph schema...')
      try {
        const out = await run('npm run db:schema', { env: portEnv })
        const indexCount = (out.match(/✓/g) || []).length
        await send('schema', 'done', `Schema ready (${indexCount} indexes)`)
      } catch (err: any) {
        await send('schema', 'error', `Schema failed: ${err.message.slice(0, 150)}`)
      }

      // ── Step 3: CPG (Joern → import) ───────
      await send('cpg', 'running', `Generating code structure (${repos.length} repos)...`)
      let cpgOk = 0

      for (let i = 0; i < repos.length; i++) {
        const repo = repos[i]
        const cpgBin = path.join(dataDir, `${repo.name}.cpg.bin`)
        const cpgJson = path.join(dataDir, `${repo.name}.json`)

        await send('cpg', 'running', `[${i + 1}/${repos.length}] ${repo.name}: Parsing code...`, Math.round((i / repos.length) * 50))

        try {
          // joern-parse
          await run(`"${JOERN_PARSE}" "${repo.path}" -o "${cpgBin}"`, { timeout: 600000 })

          await send('cpg', 'running', `[${i + 1}/${repos.length}] ${repo.name}: Extracting entities...`, Math.round((i / repos.length) * 50 + 25))

          // joern script → json
          await run(
            `"${JOERN}" --script "${JOERN_SCRIPT}" --param cpgFile="${cpgBin}" --param outFile="${cpgJson}" --param repoName="${repo.name}"`,
            { timeout: 600000 }
          )

          await send('cpg', 'running', `[${i + 1}/${repos.length}] ${repo.name}: Importing to graph...`)

          // ingest
          await run(`npm run ingest:cpg -- --file "${cpgJson}"`, { env: portEnv })

          cpgOk++
          await send('cpg', 'running', `[${i + 1}/${repos.length}] ${repo.name} — done`, Math.round(((i + 1) / repos.length) * 100))
        } catch (err: any) {
          await send('cpg', 'running', `[${i + 1}/${repos.length}] ${repo.name} — failed: ${err.message.slice(0, 100)}`, Math.round(((i + 1) / repos.length) * 100))
        }
      }
      await send('cpg', cpgOk > 0 ? 'done' : 'error', `Code structure complete (${cpgOk}/${repos.length} repos)`, 100)

      // ── Done ───────────────────────────────
      await send('complete', 'done', 'Project initialization complete!')

    } catch (err: any) {
      await send('error', 'error', `Initialization failed: ${err.message}`)
    } finally {
      await writer.close()
    }
  })()

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
