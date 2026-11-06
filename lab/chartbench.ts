// The job chart benchmark: real background jobs from Hermes' sessions, replayed through the
// plugin's own chart registry (processes/widgets/registry.ts) with Hermes' auxiliary model
// (task `tern_charts`, through the plugin's `charts.author` RPC on the gateway). Each job's recorded output (and the log file
// its command wrote, when it is still on disk) arrives in 20 steps a second apart, starting at
// the 15 s mark, so the model is first asked on the early lines, as in a pane, and a decline is
// asked again once the output has grown. The final view is what the pane would show.
//
//   (cd frontend && bunx esbuild ../lab/chartbench.ts --bundle --platform=node --format=esm --preserve-symlinks --outfile=/tmp/chartbench.mjs)
//   HERMES_TERN_HERMES='{"argv":["hermes"]}' node /tmp/chartbench.mjs JOBS.json OUT_DIR
//
// It attaches to the profile's gateway as a pane does, in a session of its own; the gateway must
// have the plugin loaded.
//
// JOBS.json is a list of {id, command, text, file?: {path, text}}. Jobs and results are the
// user's sessions: they stay out of this repo.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { BackgroundProcess } from '../frontend/src/model.js'
import { readLaunchEnv } from '../frontend/src/config/env.js'
import { createGatewayClient } from '../frontend/src/hermes/gatewayClient.js'
import { type Author, gatewayAuthor, RejectedAnswer } from '../frontend/src/processes/widgets/author.js'
import { Charts } from '../frontend/src/processes/widgets/registry.js'
import { specSkip } from '../frontend/src/processes/widgets/spec.js'
import type { ChartView } from '../frontend/src/processes/widgets/types.js'

interface Job {
  id: string
  command: string
  text: string
  file?: { path: string; text: string }
}

const STEPS = 20
const [jobsFile, outDir] = process.argv.slice(2)

if (!jobsFile || !outDir) {
  throw new Error('usage: chartbench JOBS.json OUT_DIR')
}

const gw = createGatewayClient(readLaunchEnv())
const ready = new Promise<void>(resolve => gw.on('event', (ev: { type: string }) => ev.type === 'gateway.ready' && resolve()))
gw.start()
await ready
// The session the replies go to.
const { session_id: sid } = await gw.request<{ session_id: string }>('session.create', {})
const real = gatewayAuthor(gw, () => sid)

const jobs: Job[] = JSON.parse(readFileSync(jobsFile, 'utf8'))
mkdirSync(join(outDir, 'logs'), { recursive: true })
mkdirSync(join(outDir, 'specs'), { recursive: true })

const upTo = (text: string, step: number) => {
  const lines = text.split('\n')

  return lines.slice(0, Math.ceil((lines.length * step) / STEPS)).join('\n') + (step === STEPS ? '' : '\n')
}

async function bench(job: Job) {
  const asks: { lines: number; answer: string; ms: number }[] = []
  let pending: Promise<unknown> = Promise.resolve()
  let spec: unknown

  // The real author, recording what each request saw and answered.
  const author: Author = (request, signal) => {
    const started = Date.now()
    const lines = request.sources.reduce((n, s) => n + s.lines, 0)
    const p = real(request, signal).then(
      answer => {
        const skip = specSkip(answer)
        const refused = answer instanceof RejectedAnswer
        const kind = answer === undefined ? 'unavailable' : refused ? `refused: ${answer.errors.join('; ')}` : skip ? `skip: ${skip}` : request.rejected ? 'retry' : 'spec'
        asks.push({ answer: kind, lines, ms: Date.now() - started })

        if (answer !== undefined && !skip && !refused) {
          spec = answer
        }

        return answer
      },
      (error: unknown) => {
        asks.push({ answer: `error: ${String(error)}`, lines, ms: Date.now() - started })
        throw error
      }
    )
    pending = p.catch(() => undefined)

    return p
  }

  let now = 0
  const charts = new Charts(() => undefined, { author, now: () => now })
  const log = job.file ? join(outDir, 'logs', `${job.id}.log`) : undefined
  const command = job.file && log ? job.command.split(job.file.path).join(log) : job.command
  const p: BackgroundProcess = { command, id: job.id, lastLine: '', output: '', startedAt: 0, status: 'running' }
  let view: ChartView | undefined

  for (let step = 1; step <= STEPS; step++) {
    now = 15_000 + (step - 1) * 1000
    p.output = upTo(job.text, step)

    if (job.file && log) {
      writeFileSync(log, upTo(job.file.text, step))
    }

    if (step === STEPS) {
      p.status = 'done'
    }

    view = charts.view(p)
    // A request in flight answers before the next step, as a pane's next poll would see it.
    await pending
    view = charts.view(p)
  }

  if (spec) {
    writeFileSync(join(outDir, 'specs', `${job.id}.json`), JSON.stringify(spec))
  }

  return {
    asks,
    blocks: view?.state === 'live' ? view.blocks.map(b => b.kind) : [],
    file: job.file?.path,
    id: job.id,
    lines: job.text.split('\n').filter(l => l.trim()).length + (job.file?.text.split('\n').filter(l => l.trim()).length ?? 0),
    state: view?.state,
    title: view?.state === 'live' ? view.title : undefined,
    view
  }
}

const results: Awaited<ReturnType<typeof bench>>[] = []
let next = 0

await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!
      const r = await bench(job)
      results.push(r)
      const last = r.asks.at(-1)?.answer ?? 'not asked'
      console.log(`${r.id.padEnd(14)} ${String(r.state).padEnd(9)} asks=${r.asks.length} ${r.title ?? last.slice(0, 90)}`)
    }
  })
)

writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 1))
const live = results.filter(r => r.state === 'live').length
const reasked = results.filter(r => r.asks.some(a => a.answer.startsWith('skip')) && r.state === 'live').length
console.log(`\nlive ${live} of ${results.length}; charted after a first decline: ${reasked}; requests: ${results.reduce((n, r) => n + r.asks.length, 0)}`)
gw.kill('exit')
