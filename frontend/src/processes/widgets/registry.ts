// The charts of a session's background processes: derives each process's view from its output,
// asks the cheap model for a spec once the process has run 15 s with output worth describing,
// and re-asks when the spec stops matching. Ported from omp
// (packages/coding-agent/src/job-widgets/registry.ts); the process store asks for a view when
// output arrives and on each poll, so no timer of its own runs.

import { assertNever } from '../../core/assert.js'
import type { BackgroundProcess } from '../../model.js'

import type { Author, AuthorRequest } from './author.js'
import { FileTap, outputFiles } from './files.js'
import type { ChartMemory } from './memory.js'
import { ChartRuntime, sampleLines, type TextChunk, type TextSource } from './runtime.js'
import { type Spec, specSkip, validateSpec } from './spec.js'
import type { ChartView } from './types.js'

/** Characters an {@link OutputTap} keeps: its newest 256 Ki. */
const TAP_CAPACITY = 256 * 1024
/** Characters of a new window's start an update looks for in the last window. */
const HEAD_CHARS = 64

/**
 * A process's output as an append-only source. Streamed chunks (`agent.terminal.output`) append
 * exactly. Without them the store only has polled windows (the newest 32k, or a 200-character
 * preview), so each update appends what lies past the longest end of the last window that starts
 * the new one. A window already inside the kept text (a poll older than the chunks) adds nothing,
 * and one that shares nothing with it reads as a gap.
 */
export class OutputTap implements TextSource {
  readonly id = 'out'
  #text = ''
  /** Offset of `#text[0]`. */
  #start = 0
  #window = ''
  #open = true
  /** Chunks arrive: polled windows add nothing they do not already have. */
  #streamed = false

  constructor(readonly label: string) {}

  /** A chunk the process printed. */
  append(chunk: string) {
    if (this.#open) {
      this.#streamed = true
      this.#append(chunk)
    }
  }

  /** The store's newest window of the output. */
  update(window: string) {
    const prev = this.#window

    if (!this.#open || this.#streamed || window === prev) {
      return
    }

    this.#window = window

    if (window.startsWith(prev)) {
      return this.#append(window.slice(prev.length))
    }

    // The longest end of `prev` that starts `window`: where `window` goes on from.
    const head = window.slice(0, HEAD_CHARS)

    for (let i = prev.indexOf(head); i >= 0; i = prev.indexOf(head, i + 1)) {
      if (prev.length - i <= window.length && window.startsWith(prev.slice(i))) {
        return this.#append(window.slice(prev.length - i))
      }
    }

    // A shorter or older view of output already kept.
    if (this.#text.includes(window.slice(-HEAD_CHARS))) {
      this.#window = prev

      return
    }

    // Nothing of the last window survives: skip past what was kept, so a reader sees the gap.
    this.#start += this.#text.length + 1
    this.#text = ''
    this.#append(window)
  }

  close() {
    this.#open = false
  }

  read(from: number): TextChunk {
    const end = this.#start + this.#text.length
    const start = Math.min(Math.max(from, this.#start), end)

    return { end, open: this.#open, start, text: this.#text.slice(start - this.#start) }
  }

  #append(text: string) {
    this.#text += text
    // Trimmed in batches, so a stream of small chunks does not copy the text each time.
    const excess = this.#text.length - TAP_CAPACITY

    if (excess > TAP_CAPACITY / 4) {
      this.#text = this.#text.slice(excess)
      this.#start += excess
    }
  }
}

export interface ChartsOptions {
  /** Writes specs; absent = fallback views only. */
  author?: Author | undefined
  /** Where each process's rules (or the model's decline) are kept between panes. */
  memory?: ChartMemory
  /** Whether charts are on; read on every call. */
  enabled?: () => boolean
  now?: () => number
  /** Process age before a spec may be requested. */
  authorAfterMs?: number
  /** Spec requests in flight at once, across processes. */
  maxInFlight?: number
  /** Spec requests (each with its one retry) per process. */
  maxAttempts?: number
  /** Unmatched lines that suggest the spec stopped fitting. */
  driftLines?: number
  /** Age of the newest matched data past which drift re-authors. */
  driftStaleMs?: number
}

const DEFAULTS = { authorAfterMs: 15_000, driftLines: 200, driftStaleMs: 90_000, maxAttempts: 3, maxInFlight: 2 }

/** Lines the output needs before it is worth a spec. */
const MIN_AUTHOR_LINES = 3
/** New lines, besides doubling, before a declined process is asked again (a short log's results come late). */
const REASK_LINES = 5

/** Where a chart's spec request stands. */
type Authoring =
  /** None in flight; `attempts` requests were made. */
  | { kind: 'idle'; attempts: number }
  /** The model declined when the output had `atLines` lines (`why`, unless it was another pane's); it is asked again once the output doubled. */
  | { kind: 'declined'; attempts: number; atLines: number; why?: string }
  /** A request is in flight; `was` (its attempt counted) is where it goes back to unless the answer changes that. */
  | { kind: 'requesting'; controller: AbortController; was: Waiting }
  /** No model can write specs: none is asked for again. */
  | { kind: 'unavailable' }
  /** Exited and flushed: the view never changes again. */
  | { kind: 'frozen' }

/** No request in flight, and one may be made. */
type Waiting = Extract<Authoring, { kind: 'declined' | 'idle' }>

interface Entry {
  process: BackgroundProcess
  tap: OutputTap
  /** The log files the command writes its output to (`file:1`, …). */
  files: FileTap[]
  runtime: ChartRuntime
  view: ChartView
  /** `JSON.stringify(view)`, to keep the view's identity while it does not change. */
  viewKey: string
  authoring: Authoring
  /** Why the last request gave no spec: its error, or rules that did not fit. */
  failure?: string | undefined
  /** Why no chart was drawn when the process ended (its note then; a frozen entry knows no more). */
  endNote?: string | undefined
}

/** `a` while a request may be made; undefined while one is in flight or none will be. */
function waiting(a: Authoring): Waiting | undefined {
  switch (a.kind) {
    case 'idle':

    case 'declined':
      return a

    case 'requesting':

    case 'unavailable':

    case 'frozen':
      return undefined

    default:
      return assertNever(a)
  }
}

/** Aborts `entry`'s request in flight, if one is. */
function abortRequest(entry: Entry) {
  if (entry.authoring.kind === 'requesting') {
    entry.authoring.controller.abort()
  }
}

export class Charts {
  readonly #entries = new Map<string, Entry>()
  readonly #author: Author | undefined
  readonly #memory: ChartMemory | undefined
  readonly #enabled: () => boolean
  readonly #now: () => number
  readonly #changed: () => void
  readonly #o: typeof DEFAULTS
  #inFlight = 0
  #disposed = false

  /** `changed` runs when a spec arrives, so the surfaces showing the chart redraw. */
  constructor(changed: () => void, options: ChartsOptions = {}) {
    this.#changed = changed
    this.#author = options.author
    this.#memory = options.memory
    this.#enabled = options.enabled ?? (() => true)
    this.#now = options.now ?? Date.now
    this.#o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([k, v]) => k in DEFAULTS && v !== undefined)) }
  }

  /** The process's chart now, after reading the output that arrived since the last call; undefined when charts are off. */
  view(p: BackgroundProcess): ChartView | undefined {
    if (this.#disposed || !this.#enabled()) {
      return undefined
    }

    let entry = this.#entries.get(p.id)

    if (!entry) {
      const tap = new OutputTap(p.command)
      // Rules another pane (or this one, before) already got for the process.
      const known = this.#memory?.load(p.id)
      const runtime = new ChartRuntime(known && !('skip' in known) ? known : undefined, p.startedAt, this.#now)

      entry = {
        authoring: known && 'skip' in known ? { atLines: known.skip, attempts: 0, kind: 'declined' } : { attempts: 0, kind: 'idle' },
        files: outputFiles(p.command).map((path, i) => new FileTap(`file:${i + 1}`, path)),
        process: p,
        runtime,
        tap,
        view: runtime.view({ authoring: false, label: p.command }),
        viewKey: ''
      }

      this.#entries.set(p.id, entry)
    }

    entry.process = p
    this.#refresh(entry)

    return entry.view
  }

  /** A chunk process `id` printed, for its chart's exact stream. */
  output(id: string, chunk: string) {
    this.#entries.get(id)?.tap.append(chunk)
  }

  /** Drops the charts of processes no longer listed. */
  retain(ids: ReadonlySet<string>) {
    for (const [id, entry] of this.#entries) {
      if (!ids.has(id)) {
        abortRequest(entry)
        this.#entries.delete(id)
      }
    }
  }

  dispose() {
    this.#disposed = true
    this.#entries.forEach(abortRequest)
    this.#entries.clear()
  }

  /** Reads the new output; an exited process gets one flushing read and freezes. */
  #refresh(entry: Entry) {
    if (entry.authoring.kind === 'frozen') {
      return
    }

    const now = this.#now()
    const settled = entry.process.state.status !== 'running'
    entry.tap.update(entry.process.output)
    entry.files.forEach(f => f.update())

    if (settled) {
      entry.tap.close()
      entry.files.forEach(f => f.close())
    }

    entry.runtime.ingest([entry.tap, ...entry.files], settled)

    if (settled) {
      // Cleared here, not in the request's `finally`: the view recomputed below is its last.
      abortRequest(entry)
      entry.endNote = this.#note(entry)
      entry.authoring = { kind: 'frozen' }
    } else {
      this.#maybeAuthor(entry, now)
    }

    this.#recompute(entry)
  }

  #recompute(entry: Entry): boolean {
    const drawn = entry.runtime.view({ authoring: entry.authoring.kind === 'requesting', label: entry.process.command })
    const note = drawn.state === 'fallback' ? this.#note(entry) : undefined
    const view = note ? { ...drawn, note } : drawn
    const key = JSON.stringify(view)

    if (key === entry.viewKey) {
      return false
    }

    entry.view = view
    entry.viewKey = key

    return true
  }

  /** Why `entry` has no chart now, in the user's words; undefined while one is being written. */
  #note(entry: Entry): string | undefined {
    const a = entry.authoring
    const failed = entry.failure ? `The chart model failed: ${entry.failure.replace(/\.$/, '')}.` : undefined

    switch (a.kind) {
      case 'requesting':
        return undefined

      case 'frozen':
        return entry.endNote ?? 'The process ended before a chart was written.'

      case 'unavailable':
        return 'No chart: no auxiliary model is set up for charts (auxiliary.tern_charts in config.yaml).'

      case 'declined': {
        // The model's reason often restates the verdict ("nothing to chart"); then the generic line says more.
        const why = a.why?.trim().replace(/\.$/, '')
        return why && !/^nothing to chart$/i.test(why)
          ? `Nothing to chart: ${why}.`
          : 'Nothing to chart: the chart model found no quantity in this output.'
      }

      case 'idle':
        if (!this.#author) {
          return 'No chart: no chart model (the launcher named no Hermes Python to run it).'
        }

        if (a.attempts >= this.#o.maxAttempts) {
          return `${failed ?? 'The chart model gave no usable rules.'} No more tries for this process.`
        }

        return failed ?? `A chart is written once the process has run ${Math.round(this.#o.authorAfterMs / 1000)}s with output.`

      default:
        return assertNever(a)
    }
  }

  /** Starts a spec request once the process is old and talkative enough, or re-authors a spec that stopped fitting. */
  #maybeAuthor(entry: Entry, now: number) {
    const author = this.#author
    const state = waiting(entry.authoring)

    if (!author || !state || state.attempts >= this.#o.maxAttempts || this.#inFlight >= this.#o.maxInFlight) {
      return
    }

    if (now - entry.process.startedAt < this.#o.authorAfterMs) {
      return
    }

    const runtime = entry.runtime
    let previous: AuthorRequest['previous']

    if (runtime.spec) {
      const reason = this.#reauthorReason(entry, now)

      if (!reason) {
        return
      }

      previous = { reason, spec: runtime.spec }
    } else if (!runtime.samples().some(s => s.lines >= MIN_AUTHOR_LINES)) {
      return
    } else if (state.kind === 'declined' && runtime.totalLines < Math.max(2 * state.atLines, state.atLines + REASK_LINES)) {
      // Declined on fewer lines (shell start-up noise, a banner): asked again once the output has grown.
      return
    }

    void this.#writeSpec(entry, { author, previous, was: state })
  }

  #reauthorReason(entry: Entry, now: number): string | undefined {
    const runtime = entry.runtime

    if (runtime.unmatchedLines < this.#o.driftLines) {
      return undefined
    }

    const newest = runtime.lastMatchAt

    if (newest !== undefined && now - newest <= this.#o.driftStaleMs) {
      return undefined
    }

    return `no rule matched the last ${runtime.unmatchedLines} lines`
  }

  /**
   * One spec request by `author` (plus one retry on a rejected answer); installs the spec when it
   * validates. `was` is where the request started from, `previous` the spec it replaces.
   */
  async #writeSpec(entry: Entry, { author, previous, was }: { author: Author; previous: AuthorRequest['previous']; was: Waiting }) {
    const controller = new AbortController()
    // A failed request counts as an attempt too.
    const counted: Waiting = { ...was, attempts: was.attempts + 1 }
    entry.authoring = { controller, kind: 'requesting', was: counted }
    // Where the request leaves the entry: back where it was, unless the answer says otherwise.
    let next: Authoring = counted
    this.#inFlight++

    if (this.#recompute(entry)) {
      this.#changed()
    }

    const samples = entry.runtime.samples()
    const request: AuthorRequest = { command: entry.process.command, id: entry.process.id, sources: samples, ...(previous ? { previous } : {}) }
    let spec: Spec | undefined

    try {
      for (let round = 0; round < 2 && !spec; round++) {
        const answer = await author(request, controller.signal)

        if (controller.signal.aborted) {
          return
        }

        if (answer === undefined) {
          // No model can write specs.
          next = { kind: 'unavailable' }

          break
        }

        const skip = specSkip(answer)

        if (skip !== undefined) {
          // Nothing in the output so far is worth charting.
          next = { atLines: entry.runtime.totalLines, attempts: counted.attempts, kind: 'declined', why: skip }
          this.#memory?.save(entry.process.id, { skip: next.atLines })

          break
        }

        const checked = validateSpec(answer, sampleLines(samples), entry.process.command)

        if (checked.ok) {
          spec = checked.spec
        } else {
          request.rejected = { answer: JSON.stringify(answer), errors: checked.errors }
        }
      }

      entry.failure = spec || next.kind !== 'idle' ? undefined : 'its rules did not fit the output'
    } catch (error) {
      // A failed request counts as an attempt; the next refresh may ask again. Its note says why.
      entry.failure = error instanceof Error ? error.message : String(error)
    } finally {
      this.#inFlight--

      if (entry.authoring.kind === 'requesting' && entry.authoring.controller === controller) {
        entry.authoring = next
      }
    }

    if (controller.signal.aborted || this.#entries.get(entry.process.id) !== entry) {
      return
    }

    if (spec) {
      this.#memory?.save(entry.process.id, spec)
      // A new spec rereads the output from its oldest retained text.
      entry.runtime = new ChartRuntime(spec, entry.process.startedAt, this.#now)
      entry.tap.update(entry.process.output)
      entry.runtime.ingest([entry.tap, ...entry.files], entry.process.state.status !== 'running')
    }

    if (this.#recompute(entry)) {
      this.#changed()
    }
  }
}
