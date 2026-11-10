// The cheap-model side of job charts: one request to Hermes' auxiliary model (task `tern_charts`,
// so `auxiliary.tern_charts` in config.yaml picks its model) for one JSON answer in the shape the
// system prompt documents, fed the command and samples of its output. The plugin's Python half runs the
// request (charts.py, the plugin RPC method `plugin.hermes-tern.charts.author`) and redacts
// secrets before anything leaves; its reply comes back as a session event.
// Ported from omp (packages/coding-agent/src/job-widgets/author.ts and its two prompts).

import { randomUUID } from 'node:crypto'

import { clip } from '../../core/text.js'
import { readChartReply } from '../../wire/charts.js'

import type { SourceSample } from './runtime.js'
import type { Spec } from './spec.js'

/** What the author is asked to write a spec for. */
export interface AuthorRequest {
  /** The process id. */
  id: string
  command: string
  /** Per source: first and last lines, most active first. */
  sources: readonly SourceSample[]
  /** Re-authoring: the spec in place and why it is being replaced. */
  previous?: { spec: Spec; reason: string }
  /** Retry: the rejected answer and what was wrong with it. */
  rejected?: { answer: string; errors: string[] }
}

/** An answer the author refused before validation: not one JSON object, or not the schema's shape. */
export class RejectedAnswer {
  constructor(
    /** The model's text; empty when it was not kept. */
    readonly answer: string,
    readonly errors: string[]
  ) {}
}

/**
 * Writes one candidate spec (unvalidated), or a {@link RejectedAnswer} to ask again about;
 * undefined when no model can write specs at all.
 */
export type Author = (request: AuthorRequest, signal: AbortSignal) => Promise<unknown>

const MAX_BRIEF_CHARS = 1500
const MAX_SAMPLE_LINE_CHARS = 300
const MAX_SAMPLE_BYTES = 12 * 1024
/** Lines of one shape (the same but for digits and spacing) the head, and the tail, keep. */
const MAX_SHAPE_REPEATS = 3
const REQUEST_TIMEOUT_MS = 120_000

export const SYSTEM_PROMPT = `You design the live status widget of a coding agent's background process (benchmark, eval, CI, tests, build, training, server). From the command and samples of its output you write a spec once; plain code then runs its regexes on every new line and redraws the widget until the process ends. Nobody can fix it later: its rules MUST match the real lines.

A widget charts a quantity that shows how the process is going: throughput, latency, loss, tests or trials passed, progress toward a total the process states. When the output has none, answer with only \`{"skip":"<why>"}\`; no widget beats a meaningless one. Never chart activity: lines or matches seen, words like \`error\` inside file contents.

Otherwise answer with one JSON object of:
- \`title\` (≤ 48 chars): what is watched.
- \`rules\` (1–12) \`{from, match, key?, text?, count?, scale?}\`:
  - \`from\`: the sample source id carrying the data (\`out\` for the process's output, \`file:1\` for a log file the command writes to), \`*\` for all.
  - \`match\`: a JavaScript regex on one line; no lookaround or backreferences. Copy the literal text around the data from the samples; allow varying digits (\`[\\d.]+\`) and widths (\`\\s+\`).
  - Each named group \`(?P<name>…)\` feeds field \`name\` (\`[a-z][a-z0-9_]*\`) with its number (\`1,234\`, \`4.5k\` parse). One rule can capture several fields of a line.
  - \`key\`: the rule's group naming a series (model, shard, CI job); the rule's fields keep one series per key. Not a field itself.
  - \`text\`: the rule's group kept as text (status word, test name).
  - \`count\`: a field counting matching lines.
  - \`scale\`: multiplies the rule's numbers.
- \`blocks\` (1–4, most important first), each on a \`field\`:
  - \`spark\`: numbers over time. \`label\`, \`key?\` (one key value, e.g. \`gpt-5\`), \`unit?\`, \`better?\` (\`higher\`|\`lower\`), \`target?\` + \`targetLabel?\` (goal line the command or output states), \`min?\`, \`max?\`.
  - \`bars\`: one bar per key, reduced by \`agg\`. \`label\`, \`unit?\`, \`max?\`, \`better?\`.
  - \`meter\`: \`agg\` out of a \`total\` (a value ref, or a number the process or its output states; never a guess), \`label\`, \`unit?\`.
  - \`stat\`: \`items\`, 1–4 value refs with \`label\`.
  - \`grid\`: a cell per key, coloured by latest text. \`label\`, \`tones\`: lowercase status substring → \`success\`|\`error\`|\`warning\`|\`pending\`|\`info\`|\`muted\`|\`neutral\`.
  - \`text\`: the field's latest text.
- \`headline?\`: the value ref to glance at. \`stage?\`: field whose latest text is the current step.

Value ref: \`{field, agg, label?, key?, unit?, digits?, better?}\`; \`key\` is one key value, \`better\` adds a trend arrow. \`agg\` over numbers: \`last\` \`first\` \`min\` \`max\` \`mean\` \`sum\` \`delta\` \`change\` (%); over matches: \`count\`, \`rate\` (/s, last minute).

Chart what a watcher wants: throughput or latency against the goal, progress toward a known total, per-model results, failures. Few accurate blocks; never invent lines the samples lack. Omit optional properties you do not need.

Examples:

\`req 8 rps=56 p50=41ms\`, goal 60 req/s:
{"title":"load test · rps","rules":[{"from":"out","match":"^req \\\\d+ rps=(?P<rps>[\\\\d.]+) p50=(?P<p50>[\\\\d.]+)ms"}],"blocks":[{"kind":"spark","field":"rps","label":"req/s","unit":"req/s","better":"higher","target":60,"targetLabel":"goal 60"},{"kind":"stat","items":[{"field":"p50","agg":"last","label":"p50","unit":"ms","better":"lower"}]}],"headline":{"field":"rps","agg":"last","unit":"req/s","better":"higher"}}

\`finish bash openai/gpt-5 t2: reward=1 tests=27/36 turns=5\`, 9 trials:
{"title":"eval · tests passed per model","rules":[{"from":"out","match":"^finish \\\\S+ (?P<model>\\\\S+) t\\\\d+: .*tests=(?P<passed>\\\\d+)/\\\\d+","key":"model","count":"trials"}],"blocks":[{"kind":"bars","field":"passed","agg":"mean","label":"tests passed","max":36,"better":"higher"},{"kind":"meter","field":"trials","agg":"count","total":9,"label":"trials"}]}

\`✓ lint (1m02s)\` / \`✗ test-linux (4m11s)\` / \`* build-macos\`:
{"title":"CI · 6 jobs","rules":[{"from":"*","match":"^(?P<mark>[✓✗*-])\\\\s+(?P<name>\\\\S+)","key":"name","text":"mark"}],"blocks":[{"kind":"grid","field":"mark","label":"jobs","tones":{"✓":"success","✗":"error","*":"pending","-":"muted"}}]}

pytest, \`tests/test_api.py::test_login PASSED [ 12%]\`:
{"title":"pytest · tests/","rules":[{"from":"out","match":" PASSED ","count":"pass"},{"from":"out","match":" FAILED ","count":"fail"},{"from":"out","match":"^(?P<current>\\\\S+::\\\\S+) \\\\w+\\\\s+\\\\[\\\\s*(?P<pct>\\\\d+)%\\\\]","text":"current"}],"blocks":[{"kind":"meter","field":"pct","agg":"last","total":100,"label":"progress","unit":"%"},{"kind":"stat","items":[{"field":"pass","agg":"count","label":"passed"},{"field":"fail","agg":"count","label":"failed"}]}],"stage":"current"}`

const byteLength = (s: string) => Buffer.byteLength(s) + 1

interface PromptSource {
  id: string
  label: string
  lines: number
  size: number
  omitted: number
  head: string[]
  tail: string[]
}

/**
 * Sample lines for the prompt: each cut at 300 chars, the first lines then the last per source,
 * ≤ 12 KB in total, sources sharing what is left fairly. The head and the tail each keep at most
 * three lines of one shape (a progress line repeating with new numbers), so a busy source shows
 * its distinct lines. Lines that would open or close the prompt's code fence are left out.
 */
export function promptSources(sources: readonly SourceSample[]): PromptSource[] {
  let budget = MAX_SAMPLE_BYTES

  return sources.map((source, index) => {
    const share = Math.floor(budget / (sources.length - index))

    const take = (lines: readonly string[], limit: number): string[] => {
      const out: string[] = []
      const shapes = new Map<string, number>()
      let used = 0

      for (const line of lines) {
        const trimmed = line.trimStart()

        if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
          continue
        }

        const shape = trimmed.replace(/\d+/g, '0').replace(/\s+/g, ' ')
        const repeats = shapes.get(shape) ?? 0

        if (repeats >= MAX_SHAPE_REPEATS) {
          continue
        }

        shapes.set(shape, repeats + 1)
        const sample = clip(line, { max: MAX_SAMPLE_LINE_CHARS })

        if (used + byteLength(sample) > limit) {
          break
        }

        used += byteLength(sample)
        out.push(sample)
      }

      budget -= used

      return out
    }

    // The newest lines show what it prints now; they get two thirds of the share first.
    const tail = take(source.tail.slice().reverse(), source.head.length ? Math.floor((share * 2) / 3) : share).reverse()
    const head = take(source.head, share - tail.reduce((n, l) => n + byteLength(l), 0))

    return {
      head,
      id: source.id,
      label: source.label,
      lines: source.lines,
      omitted: Math.max(0, source.lines - head.length - tail.length),
      size: source.size,
      tail
    }
  })
}

/** The user message of a request. */
export function renderPrompt(request: AuthorRequest): string {
  const fence = (body: string) => `\`\`\`\n${body}\n\`\`\``
  const out = ['<job>', 'Background process. Command:', fence(clip(request.command.trim(), { max: MAX_BRIEF_CHARS })), '</job>', '', '<sources>']

  for (const s of promptSources(request.sources)) {
    const omitted = s.omitted ? ` ${s.omitted} not shown: the middle, and repeats of a line that differ only in numbers.` : ''
    const tail = s.tail.length ? [...(s.omitted ? ['[…]'] : []), ...s.tail] : []
    out.push(`## \`${s.id}\` — ${s.label}`, `${s.lines} lines so far (${s.size} characters).${omitted}`, fence([...s.head, ...tail].join('\n')))
  }

  out.push('</sources>')

  if (request.previous) {
    out.push(
      '',
      `A spec is already in place, but ${request.previous.reason}. Write a replacement that matches the lines above:`,
      fence(JSON.stringify(request.previous.spec))
    )
  }

  if (request.rejected) {
    out.push(
      '',
      'Your previous answer was rejected:',
      ...(request.rejected.answer ? [fence(clip(request.rejected.answer, { max: 4000 }))] : []),
      'Problems:',
      ...request.rejected.errors.map(e => `- ${e}`),
      'Fix every problem and answer again.'
    )
  }

  return out.join('\n')
}

/** The plugin RPC method that starts a request, and the session event that answers it (charts.py). */
export const AUTHOR_METHOD = 'plugin.hermes-tern.charts.author'
export const AUTHOR_EVENT = 'plugin.hermes-tern.charts.authored'

/** What the author reaches of the gateway client: its requests, and its events for the reply. */
export interface AuthorGateway {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: 'event', listener: (ev: { type: string; payload?: unknown }) => void): unknown
}

/** A JSON-RPC "method not found": a Hermes without plugin RPC methods, or a gateway without the plugin loaded. */
const unknownMethod = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === -32601

/**
 * An {@link Author} that asks the plugin's Python half over `gw`: the call starts the request and
 * answers at once, and the reply arrives as the `plugin.hermes-tern.charts.authored` event of the
 * session `sid()` names. It resolves undefined when the gateway does not serve the method.
 */
export function gatewayAuthor(gw: AuthorGateway, sid: () => null | string): Author {
  const waiting = new Map<string, (reply: ReturnType<typeof readChartReply>) => void>()

  gw.on('event', ev => {
    const reply = ev.type === AUTHOR_EVENT ? readChartReply(ev.payload) : undefined

    if (reply) {
      waiting.get(reply.job)?.(reply)
    }
  })

  return async (request, signal) => {
    const session = sid()

    if (!session) {
      throw new Error('no session to send the chart request from')
    }

    const job = randomUUID()
    const reply = new Promise<ReturnType<typeof readChartReply>>((resolve, reject) => {
      const done = () => {
        waiting.delete(job)
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
      }
      const abort = () => (done(), reject(signal.reason))
      const timer = setTimeout(() => (done(), reject(new Error('the chart request timed out'))), REQUEST_TIMEOUT_MS)

      signal.addEventListener('abort', abort, { once: true })
      waiting.set(job, r => (done(), resolve(r)))
    })

    // A failed call ends the wait for its reply.
    const ack = gw
      .request(AUTHOR_METHOD, { job, session_id: session, system: SYSTEM_PROMPT, user: renderPrompt(request) })
      .catch((error: unknown) => {
        waiting.get(job)?.(undefined)
        throw error
      })
    let answer: ReturnType<typeof readChartReply>

    try {
      // Both at once: an abort or a timeout while the call is still unanswered rejects right away.
      ;[, answer] = await Promise.all([ack, reply])
    } catch (error) {
      if (unknownMethod(error)) {
        return undefined
      }

      throw error
    }

    switch (answer?.kind) {
      case 'answer':
        return answer.answer
      case 'rejected':
        return new RejectedAnswer(answer.answer, answer.errors)
      case 'error':
        throw new Error(answer.message)
      default:
        return undefined
    }
  }
}
