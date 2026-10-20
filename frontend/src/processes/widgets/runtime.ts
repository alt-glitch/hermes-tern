// Deterministic derivation of a process's chart: read the new output, split it into lines,
// apply the spec's rules, fold the matches into per-field series, and turn spec + state into a
// ChartView. No model takes part past the spec, and the work per refresh is proportional to the
// new text: series keep bounded rings. Ported from omp (packages/coding-agent/src/job-widgets/runtime.ts).

import type { Tone } from '@stencil-hq/tern'

import { formatNumber, formatRatio, formatTrend } from './format.js'
import {
  type Agg,
  type BlockSpec,
  type Captures,
  LineMatcher,
  MAX_TITLE_CHARS,
  parseValue,
  type Rule,
  ruleFields,
  ruleReadsSource,
  type SampleLines,
  type Spec,
  type SparkSpec,
  type ValueRef
} from './spec.js'
import type { Block, ChartState, ChartView, Headline, SparkBlock, Trend } from './types.js'

/** Longest line kept; longer lines are cut. */
export const MAX_LINE_CHARS = 4096
/** Points a series keeps for sparks. */
const RING_POINTS = 240
/** Points a spark draws after downsampling. */
export const SPARK_POINTS = 48
/** Window of `rate` and lines/s. */
export const RATE_WINDOW_MS = 60_000
/** Non-empty lines kept from the start of a source, for the author's samples. */
const SAMPLE_HEAD_LINES = 30
/** Non-empty lines kept from its end. */
const SAMPLE_TAIL_LINES = 60
const MAX_STAGE_CHARS = 200
const MAX_TEXT_CHARS = 200
const MAX_BAR_ITEMS = 16
const MAX_GRID_ITEMS = 48

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// ── Sources ────────────────────────────────────────────────────────────────────────────────

/** Retained text of a source from some offset on. */
export interface TextChunk {
  /** Offset of `text`'s first unit; past the requested one when older text was dropped. */
  start: number
  /** Offset just past `text`: the next read's `from`. */
  end: number
  text: string
  /** Whether more text may arrive. */
  open: boolean
}

/** Text a process produces over time, readable from any offset still retained. */
export interface TextSource {
  /** The id a rule names in `from`: `out`. */
  readonly id: string
  /** What the text is, for the author. */
  readonly label: string
  read(from: number): TextChunk
}

// eslint-disable-next-line no-control-regex -- terminal escapes and control characters are what this strips
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/g

/** A line as rules read it: escapes and control characters gone, tabs as spaces. */
function clean(line: string): string {
  return line.replace(/\t/g, ' ').replace(ESCAPES, '')
}

/**
 * Reads one source between refreshes: keeps a cursor, carries the trailing partial line to the
 * next read, turns CR/CRLF into line breaks and cuts lines at {@link MAX_LINE_CHARS}. When the
 * source dropped text the reader never saw, the torn line at the gap is skipped.
 */
export class SourceLineReader {
  #cursor = 0
  #partial = ''
  #torn = false

  constructor(readonly source: TextSource) {}

  /** New complete lines; `flush` also ends the line in progress (the process exited). */
  read(flush: boolean): { lines: string[]; open: boolean; end: number } {
    const chunk = this.source.read(this.#cursor)
    let text = chunk.text

    if (chunk.start > this.#cursor) {
      this.#partial = ''
      this.#torn = true
    }

    this.#cursor = Math.max(this.#cursor, chunk.end)

    if (this.#torn) {
      const lineEnd = text.search(/[\r\n]/)

      if (lineEnd === -1) {
        text = ''
      } else {
        text = text.slice(lineEnd + 1)
        this.#torn = false
      }
    }

    const raw = (this.#partial + text).replace(/\r\n?/g, '\n').split('\n')
    this.#partial = (raw.pop() ?? '').slice(0, MAX_LINE_CHARS * 2)

    if ((flush || !chunk.open) && this.#partial) {
      raw.push(this.#partial)
      this.#partial = ''
    }

    return { end: chunk.end, lines: raw.map(l => clean(l).slice(0, MAX_LINE_CHARS)), open: chunk.open }
  }
}

// ── Series ─────────────────────────────────────────────────────────────────────────────────

/** One key's (or all keys') accumulated matches. */
export interface Series {
  /** Matches, including those that carried no number. */
  count: number
  /** Numbers folded in. */
  values: number
  first: number
  last: number
  min: number
  max: number
  sum: number
  /** Matches per refresh time within the last {@link RATE_WINDOW_MS}, oldest first. */
  recent: { t: number; n: number }[]
  /** Newest values with their times, oldest first. */
  ring: { t: number; v: number }[]
  /** Latest captured text. */
  text?: string
  /** Latest matching line. */
  line?: string
  updatedAt: number
}

function emptySeries(): Series {
  return { count: 0, first: 0, last: 0, max: -Infinity, min: Infinity, recent: [], ring: [], sum: 0, updatedAt: 0, values: 0 }
}

function pushMatch(s: Series, value: number | undefined, text: string | undefined, line: string, t: number) {
  s.count++
  const bucket = s.recent.at(-1)

  if (bucket?.t === t) {
    bucket.n++
  } else {
    s.recent.push({ n: 1, t })
    const horizon = t - RATE_WINDOW_MS
    let stale = 0

    while (stale < s.recent.length && s.recent[stale]!.t < horizon) {
      stale++
    }

    s.recent.splice(0, stale)
  }

  if (value !== undefined) {
    if (!s.values) {
      s.first = value
    }

    s.values++
    s.last = value
    s.min = Math.min(s.min, value)
    s.max = Math.max(s.max, value)
    s.sum += value
    s.ring.push({ t, v: value })

    // Trimmed in batches: dropping the oldest point on every push would copy the ring each time.
    if (s.ring.length >= RING_POINTS * 2) {
      s.ring.splice(0, s.ring.length - RING_POINTS)
    }
  }

  if (text) {
    s.text = text
  }

  s.line = line
  s.updatedAt = t
}

/** The window `rate` divides by: the last minute, or the process's age when younger, at least 1 s. */
function rateWindowMs(now: number, startTime: number): number {
  return Math.min(RATE_WINDOW_MS, Math.max(1000, now - startTime))
}

/**
 * Reduces a series. `count` and `rate` are defined on an empty series (0); value aggregations
 * are undefined until a number arrived, and `change` when it would divide by a zero start.
 */
export function aggregate(s: Series, agg: Agg, now: number, startTime: number): number | undefined {
  if (agg === 'count') {
    return s.count
  }

  if (agg === 'rate') {
    const horizon = now - RATE_WINDOW_MS
    const inWindow = s.recent.reduce((n, b) => (b.t >= horizon ? n + b.n : n), 0)

    return inWindow / (rateWindowMs(now, startTime) / 1000)
  }

  if (!s.values) {
    return undefined
  }

  switch (agg) {
    case 'last':
      return s.last

    case 'first':
      return s.first

    case 'min':
      return s.min

    case 'max':
      return s.max

    case 'sum':
      return s.sum

    case 'mean':
      return s.sum / s.values

    case 'delta':
      return s.last - s.first

    case 'change':
      if (s.first === 0) {
        return s.last === 0 ? 0 : undefined
      }

      return ((s.last - s.first) / Math.abs(s.first)) * 100
  }
}

/** Equal-count bucket means, at most `points` of them, each with its last point's time. */
export function downsample(ring: readonly { t: number; v: number }[], points: number): { t: number; v: number }[] {
  if (ring.length <= points) {
    return ring.slice()
  }

  const out: { t: number; v: number }[] = []

  for (let b = 0; b < points; b++) {
    const from = Math.floor((b * ring.length) / points)
    const to = Math.floor(((b + 1) * ring.length) / points)
    let sum = 0

    for (let i = from; i < to; i++) {
      sum += ring[i]!.v
    }

    out.push({ t: ring[to - 1]!.t, v: sum / (to - from) })
  }

  return out
}

/** A field's series per key (`""` when its rules capture no key), plus every match merged. */
interface FieldState {
  keys: Map<string, Series>
  all: Series
}

/** One rule as the runtime applies it, with its pattern's groups resolved to positions. */
interface CompiledRule {
  /** Position of the key group among the pattern's named groups; -1 without a key. */
  key: number
  captures: { index: number; field: string; text: boolean }[]
  count: string | undefined
  scale: number
}

/** The rules reading one source, matched over their distinct patterns. */
interface SourceMatcher {
  matcher: LineMatcher
  /** Per pattern, the rules using it, in spec order. */
  rules: CompiledRule[][]
}

function compileRule(rule: Rule, groups: readonly string[]): CompiledRule {
  return {
    captures: groups.flatMap((field, index) => (field === rule.key ? [] : [{ field, index, text: field === rule.text }])),
    count: rule.count,
    key: rule.key === undefined ? -1 : groups.indexOf(rule.key),
    scale: rule.scale ?? 1
  }
}

/** Per-source line statistics: the fallback view and the author's samples. */
interface SourceStats {
  id: string
  label: string
  size: number
  lines: number
  head: string[]
  tail: string[]
  lastLine?: string
  lastActiveAt: number
  /** Non-empty lines per refresh within the rate window. */
  recent: { t: number; n: number }[]
}

/** What the author reads about one source. */
export interface SourceSample {
  id: string
  label: string
  /** Characters read so far. */
  size: number
  /** Non-empty lines read so far. */
  lines: number
  /** First and last non-empty lines (no overlap), oldest first. */
  head: string[]
  tail: string[]
}

/**
 * One process's derivation state under one spec (or none: the fallback view). Installing a new
 * spec starts a fresh runtime that rereads the source from its oldest retained text.
 */
export class ChartRuntime {
  readonly #readers = new Map<string, SourceLineReader>()
  readonly #stats = new Map<string, SourceStats>()
  readonly #fields = new Map<string, FieldState>()
  readonly #matchers = new Map<string, SourceMatcher | null>()
  /** Fields some rule splits by key; every other field keeps a single series. */
  readonly #keyedFields = new Set<string>()
  #lastMatchAt: number | undefined
  #lastLineAt: number | undefined
  /** Non-empty lines read since the last match. */
  #unmatchedLines = 0
  /** Newest non-empty line no rule matched: a live chart's stage when the spec names none. */
  #lastUnmatchedLine: string | undefined

  constructor(
    readonly spec: Spec | undefined,
    readonly startTime: number,
    readonly now: () => number = Date.now
  ) {
    for (const rule of spec?.rules ?? []) {
      if (rule.key !== undefined) {
        ruleFields(rule).forEach(f => this.#keyedFields.add(f.field))
      }
    }
  }

  /** Lines seen since the last match. */
  get unmatchedLines(): number {
    return this.#unmatchedLines
  }

  /** Time of the newest match. */
  get lastMatchAt(): number | undefined {
    return this.#lastMatchAt
  }

  get totalLines(): number {
    return [...this.#stats.values()].reduce((n, s) => n + s.lines, 0)
  }

  /** Reads every source's new text; `flush` ends lines in progress. True when anything arrived. */
  ingest(sources: readonly TextSource[], flush: boolean): boolean {
    const t = this.now()
    let changed = false

    for (const source of sources) {
      let reader = this.#readers.get(source.id)

      if (!reader || reader.source !== source) {
        reader = new SourceLineReader(source)
        this.#readers.set(source.id, reader)
      }

      const { end, lines } = reader.read(flush)
      let stats = this.#stats.get(source.id)

      if (!stats) {
        stats = { head: [], id: source.id, label: source.label, lastActiveAt: 0, lines: 0, recent: [], size: 0, tail: [] }
        this.#stats.set(source.id, stats)
      }

      stats.size = end

      if (!lines.length) {
        continue
      }

      changed = true
      this.#recordLines(stats, lines, t)
      this.#matchLines(source.id, lines, t)
    }

    return changed
  }

  #recordLines(stats: SourceStats, lines: readonly string[], t: number) {
    let fresh = 0
    // Lines before `tailFrom` filled the head; the tail needs only the newest non-empty ones.
    let tailFrom = 0

    lines.forEach((line, i) => {
      if (!line.trim()) {
        return
      }

      fresh++

      if (stats.head.length < SAMPLE_HEAD_LINES) {
        stats.head.push(line)
        tailFrom = i + 1
      }
    })

    if (!fresh) {
      return
    }

    const newest: string[] = []

    for (let i = lines.length - 1; i >= tailFrom && newest.length < SAMPLE_TAIL_LINES; i--) {
      if (lines[i]!.trim()) {
        newest.push(lines[i]!)
      }
    }

    if (newest.length) {
      stats.lastLine = newest[0]
      newest.reverse()
      stats.tail = [...stats.tail, ...newest].slice(-SAMPLE_TAIL_LINES)
    } else {
      stats.lastLine = stats.head.at(-1)
    }

    stats.lines += fresh
    stats.lastActiveAt = t
    this.#lastLineAt = t
    stats.recent.push({ n: fresh, t })

    while (stats.recent.length && stats.recent[0]!.t < t - RATE_WINDOW_MS) {
      stats.recent.shift()
    }
  }

  /** The matcher of the rules reading source `id`, compiled on first use. */
  #sourceMatcher(id: string): SourceMatcher | undefined {
    const known = this.#matchers.get(id)

    if (known !== undefined) {
      return known ?? undefined
    }

    // Rules sharing a pattern (one line read into several fields) run it once.
    const byPattern = new Map<string, Rule[]>()

    for (const rule of this.spec?.rules ?? []) {
      if (ruleReadsSource(rule.from, id)) {
        byPattern.set(rule.match, [...(byPattern.get(rule.match) ?? []), rule])
      }
    }

    if (!byPattern.size) {
      this.#matchers.set(id, null)

      return undefined
    }

    const patterns = [...byPattern.keys()]
    const matcher = new LineMatcher(patterns)
    const groups = matcher.groupNames()

    const entry: SourceMatcher = {
      matcher,
      rules: patterns.map((p, i) => byPattern.get(p)!.map(r => compileRule(r, groups[i]!)))
    }

    this.#matchers.set(id, entry)

    return entry
  }

  #matchLines(sourceId: string, lines: readonly string[], t: number) {
    const entry = this.#sourceMatcher(sourceId)

    if (!entry) {
      return
    }

    const hits = entry.matcher.matchLines(lines)
    const capture = (captures: Captures, at: number) => (at < 0 ? undefined : captures[at])

    for (const hit of hits) {
      const line = lines[hit.line]!

      for (const rule of entry.rules[hit.pattern]!) {
        const key = capture(hit.captures, rule.key)?.trim() ?? ''

        for (const c of rule.captures) {
          const captured = hit.captures[c.index]

          if (captured === undefined) {
            continue
          }

          const value = c.text ? Number.NaN : parseValue(captured) * rule.scale

          // A capture holding no number is kept as text, so a status word still reaches grids.
          if (Number.isFinite(value)) {
            this.#push(c.field, key, value, undefined, line, t)
          } else {
            this.#push(c.field, key, undefined, captured.trim(), line, t)
          }
        }

        if (rule.count !== undefined) {
          this.#push(rule.count, key, undefined, undefined, line, t)
        }
      }
    }

    const matched = new Set(hits.map(h => h.line))

    if (matched.size) {
      this.#lastMatchAt = t
    }

    const lastMatched = hits.length ? hits.at(-1)!.line : -1
    let unmatched = 0

    for (let i = lastMatched + 1; i < lines.length; i++) {
      if (lines[i]!.trim()) {
        unmatched++
      }
    }

    this.#unmatchedLines = lastMatched >= 0 ? unmatched : this.#unmatchedLines + unmatched

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim()

      if (line && !matched.has(i)) {
        this.#lastUnmatchedLine = cut(line, MAX_STAGE_CHARS)

        break
      }
    }
  }

  #push(name: string, key: string, value: number | undefined, text: string | undefined, line: string, t: number) {
    let field = this.#fields.get(name)

    if (!field) {
      const all = emptySeries()
      // Without keys the one series is the merged one: each match folds in once.
      field = { all, keys: this.#keyedFields.has(name) ? new Map() : new Map([['', all]]) }
      this.#fields.set(name, field)
    }

    let series = field.keys.get(key)

    if (!series) {
      series = emptySeries()
      field.keys.set(key, series)
    }

    pushMatch(series, value, text, line, t)

    if (series !== field.all) {
      pushMatch(field.all, value, text, line, t)
    }
  }

  /** First and last lines per source, most active first, for the author and the dry run. */
  samples(): SourceSample[] {
    return [...this.#stats.values()]
      .filter(s => s.lines > 0)
      .sort((a, b) => b.lines - a.lines)
      .map(s => ({ head: s.head.slice(), id: s.id, label: s.label, lines: s.lines, size: s.size, tail: s.tail.slice() }))
  }

  /** The view now: the spec's blocks when a spec drives it, else the fallback. */
  view(context: { label: string; authoring: boolean }): ChartView {
    const now = this.now()
    const updatedAt = this.#lastMatchAt ?? this.#lastLineAt ?? this.startTime
    const spec = this.spec

    if (!spec) {
      const stage = this.#lastLine()
      const state: ChartState = context.authoring ? 'authoring' : 'fallback'

      return {
        blocks: this.#fallbackBlocks(now),
        state,
        title: cut(context.label.replace(/\s+/g, ' ').trim(), MAX_TITLE_CHARS),
        updatedAt,
        ...(stage ? { stage } : {})
      }
    }

    const headline = spec.headline ? this.#headline(spec.headline, now) : undefined
    const stage = (spec.stage ? this.#specStage() : undefined) ?? this.#lastUnmatchedLine

    return {
      // A block with nothing to draw yet is left out; the head row still shows.
      blocks: spec.blocks.map(b => this.#block(b, now)).filter(hasData),
      state: 'live',
      title: spec.title,
      updatedAt,
      ...(headline ? { headline } : {}),
      ...(stage ? { stage } : {})
    }
  }

  #fallbackBlocks(now: number): Block[] {
    const total = this.totalLines

    if (!total) {
      return []
    }

    let recent = 0

    for (const stats of this.#stats.values()) {
      for (const e of stats.recent) {
        if (e.t >= now - RATE_WINDOW_MS) {
          recent += e.n
        }
      }
    }

    const perSecond = recent / (rateWindowMs(now, this.startTime) / 1000)

    return [
      {
        items: [
          { label: 'lines', text: formatNumber(total) },
          { label: 'lines/s', text: formatNumber(perSecond) }
        ],
        kind: 'stat'
      }
    ]
  }

  #specStage(): string | undefined {
    const field = this.spec?.stage ? this.#fields.get(this.spec.stage) : undefined
    const text = (field?.all.text ?? field?.all.line)?.trim()

    return text ? cut(text, MAX_STAGE_CHARS) : undefined
  }

  /** The last non-empty line of the most recently active source. */
  #lastLine(): string | undefined {
    let best: SourceStats | undefined

    for (const stats of this.#stats.values()) {
      if (stats.lastLine && (!best || stats.lastActiveAt >= best.lastActiveAt)) {
        best = stats
      }
    }

    return best?.lastLine ? cut(best.lastLine.trim(), MAX_STAGE_CHARS) : undefined
  }

  #series(field: string, key: string | undefined): Series {
    const state = this.#fields.get(field)

    if (!state) {
      return emptySeries()
    }

    return key === undefined ? state.all : (state.keys.get(key) ?? emptySeries())
  }

  #value(ref: ValueRef, now: number): { text: string; value: number | undefined; trend?: Trend } {
    const series = this.#series(ref.field, ref.key)
    const value = aggregate(series, ref.agg, now, this.startTime)
    const unit = ref.agg === 'change' ? '%' : ref.unit
    const text = value === undefined ? '—' : formatNumber(value, unit, ref.digits)
    // A trend says where the value went: only for value-like aggregations with a direction and two points.
    const trend = ref.better && TREND_AGGS.has(ref.agg) && series.values >= 2 ? formatTrend(series.first, series.last, ref.better, ref.unit) : undefined

    return { text, value, ...(trend ? { trend } : {}) }
  }

  #headline(ref: ValueRef & { label?: string }, now: number): Headline | undefined {
    const { text, trend, value } = this.#value(ref, now)

    return value === undefined ? undefined : { text, ...(ref.label ? { label: ref.label } : {}), ...(trend ? { trend } : {}) }
  }

  #block(block: BlockSpec, now: number): Block {
    switch (block.kind) {
      case 'spark':
        return this.#spark(block)

      case 'bars': {
        const state = this.#fields.get(block.field)
        const entries = state ? [...state.keys.entries()].slice(-MAX_BAR_ITEMS) : []
        const unit = block.agg === 'change' ? '%' : block.unit
        const values = entries.map(([, s]) => aggregate(s, block.agg, now, this.startTime) ?? 0)
        // With a direction, the leading bars stand out once there is something to compare.
        const best = block.better && values.length > 1 ? (block.better === 'higher' ? Math.max(...values) : Math.min(...values)) : undefined
        const labels = keyLabels(entries.map(([k]) => k))
        const peak = Math.max(0, ...values)

        return {
          items: entries.map(([k], i) => ({
            label: labels[i] || k || block.label,
            text: formatNumber(values[i]!, unit),
            value: values[i]!,
            ...(best !== undefined && values[i] === best ? { tone: 'success' } : {})
          })),
          kind: 'bars',
          label: block.label,
          max: block.max ?? (peak > 0 ? peak : 1)
        }
      }

      case 'meter': {
        const value = aggregate(this.#series(block.field, block.key), block.agg, now, this.startTime) ?? 0
        const total = typeof block.total === 'number' ? block.total : (this.#value(block.total, now).value ?? 0)

        return {
          kind: 'meter',
          label: block.label,
          text: formatRatio(value, total, block.unit),
          value: total > 0 ? Math.min(1, Math.max(0, value / total)) : 0,
          ...(total > 0 && value >= total ? { tone: 'success' } : {})
        }
      }

      case 'stat':
        return {
          items: block.items.map(item => {
            const { text, trend } = this.#value(item, now)

            return { label: item.label, text, ...(trend ? { trend } : {}) }
          }),
          kind: 'stat'
        }

      case 'grid': {
        const state = this.#fields.get(block.field)
        const entries = state ? [...state.keys.entries()].slice(-MAX_GRID_ITEMS) : []
        const labels = keyLabels(entries.map(([k]) => k))

        return {
          items: entries.map(([k, s], i) => {
            const text = cut(s.text ?? (s.values ? formatNumber(s.last) : (s.line?.trim() ?? '')), MAX_TEXT_CHARS)

            return { label: labels[i] || k || block.label, text, tone: gridTone(block.tones, text) }
          }),
          kind: 'grid',
          label: block.label
        }
      }

      case 'text': {
        const s = this.#series(block.field, undefined)

        return { kind: 'text', text: cut(s.text ?? s.line?.trim() ?? '', MAX_TEXT_CHARS) }
      }
    }
  }

  #spark(block: SparkSpec): SparkBlock {
    const series = this.#series(block.field, block.key)
    const ring = series.ring.length > RING_POINTS ? series.ring.slice(-RING_POINTS) : series.ring
    const points = downsample(ring, SPARK_POINTS)
    const values = points.map(p => p.v)

    const marks =
      block.target === undefined
        ? undefined
        : [{ label: block.targetLabel ?? `target ${formatNumber(block.target, block.unit)}`, tone: 'muted' as Tone, value: block.target }]

    const { max, min } = sparkDomain([...values, ...(marks ?? []).map(m => m.value)], block.min, block.max)
    let tone: Tone | undefined

    if (block.better && block.target !== undefined && series.values) {
      const reached = block.better === 'higher' ? series.last >= block.target : series.last <= block.target

      if (reached) {
        tone = 'success'
      }
    }

    return {
      kind: 'spark',
      label: block.label,
      last: series.values ? formatNumber(series.last, block.unit) : '—',
      max,
      min,
      tips: points.map(p => `${new Date(p.t).toTimeString().slice(0, 8)} · ${formatNumber(p.v, block.unit)}`),
      values,
      ...(marks ? { marks } : {}),
      ...(tone ? { tone } : {})
    }
  }
}

/**
 * A spark's value domain: the data's range (values and marks) padded by 10% on both sides, so a
 * series moving within 160–186 does not draw as a flat bar; a flat series pads by max(1, 5% of
 * its value). The bottom stays at or above 0 when every bound is. A spec's `min`/`max` win.
 */
export function sparkDomain(bounds: readonly number[], specMin?: number, specMax?: number): { min: number; max: number } {
  let min = 0
  let max = 1

  if (bounds.length) {
    const lo = Math.min(...bounds)
    const hi = Math.max(...bounds)
    const pad = hi > lo ? (hi - lo) * 0.1 : Math.max(1, Math.abs(hi) * 0.05)
    min = lo >= 0 ? Math.max(0, lo - pad) : lo - pad
    max = hi + pad
  }

  min = specMin ?? min
  max = specMax ?? max

  return { max: max <= min ? min + 1 : max, min }
}

/**
 * Aggregations whose value a trend arrow can describe: the latest one. A trend is the series'
 * first value to its last, which says nothing about a minimum or a maximum ("fastest 2.5 s ▲ 1647%").
 */
const TREND_AGGS = new Set<Agg>(['last'])

function hasData(block: Block): boolean {
  switch (block.kind) {
    case 'text':
      return block.text.length > 0

    case 'bars':

    case 'grid':
      return block.items.length > 0

    case 'spark':
      return block.values.length > 0

    default:
      return true
  }
}

/** Bar and cell labels: the last `/` segment when every key has one and those stay unique, else the keys. */
export function keyLabels(keys: readonly string[]): string[] {
  if (!keys.length || !keys.every(k => k.includes('/'))) {
    return keys.slice()
  }

  const short = keys.map(k => k.slice(k.lastIndexOf('/') + 1))

  return short.every(Boolean) && new Set(short).size === short.length ? short : keys.slice()
}

/** A grid cell's tone: the first `tones` entry whose status is a case-insensitive substring of the text. */
function gridTone(tones: Record<string, Tone>, text: string): Tone {
  const lower = text.toLowerCase()

  for (const [status, tone] of Object.entries(tones)) {
    if (lower.includes(status.toLowerCase())) {
      return tone
    }
  }

  return 'neutral'
}

/** Samples as plain line lists for the validation dry run. */
export function sampleLines(samples: readonly SourceSample[]): SampleLines[] {
  return samples.map(s => ({ id: s.id, lines: [...s.head, ...s.tail] }))
}
