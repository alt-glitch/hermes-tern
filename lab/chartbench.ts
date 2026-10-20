// The job chart benchmark: real background jobs from Hermes' sessions, replayed through the
// plugin's own chart registry (processes/widgets/registry.ts) with Hermes' auxiliary model
// (task `job_widget`, through `widget_author.py`). Each job's recorded output (and the log file
// its command wrote, when it is still on disk) arrives in 20 steps a second apart, starting at
// the 15 s mark, so the model is first asked on the early lines, as in a pane, and a decline is
// asked again once the output has grown. The final view is what the pane would show.
//
//   (cd frontend && bunx esbuild ../lab/chartbench.ts --bundle --platform=node --format=esm --outfile=/tmp/chartbench.mjs)
//   HERMES_PYTHON=… HERMES_PYTHON_SRC_ROOT=… HERMES_TUI_DIR=$PWD/frontend node /tmp/chartbench.mjs JOBS.json OUT_DIR
//
// JOBS.json is a list of {id, command, text, file?: {path, text}}. Jobs and results are the
// user's sessions: they stay out of this repo.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { BackgroundProcess } from '../frontend/src/model.js'
import { type Author, hermesAuthor } from '../frontend/src/processes/widgets/author.js'
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

const real = hermesAuthor()

if (!real) {
  throw new Error('set HERMES_PYTHON, HERMES_PYTHON_SRC_ROOT and HERMES_TUI_DIR')
}

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
        asks.push({ answer: answer === undefined ? 'unavailable' : skip ? `skip: ${skip}` : request.rejected ? 'retry' : 'spec', lines, ms: Date.now() - started })

        if (answer !== undefined && !skip) {
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
