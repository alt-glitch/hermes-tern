// Job charts as TSP nodes: the shells pill's glance and mini chart, its hover card of tiles (one
// per running process), the whole chart in the Background sheet, and the primary block on a
// background terminal card. Roles and layout follow omp's (packages/tui/src/tools/job-widget.ts),
// so Tern's omp styles draw them; chart props Tern 0.9.5 added (`min`, `max`, dashed `marks`,
// per-column `tone`) and `hovercard` are not in the SDK's types yet, so those nodes are built raw.

import { type JSX, Node, node, type NodeJson, type SpanData, type Tone } from '@stencil-hq/tern'

import type { BackgroundProcess } from '../../model.js'
import { PROCESS_LOOK } from '../look.js'

import type { Block, ChartView, SparkBlock, StatBlock, Trend } from './types.js'

/** Points the pill's mini chart keeps from the primary spark. */
const MINI_SPARK_POINTS = 16
/** Tiles the hover card shows before it counts the rest. */
const HOVERCARD_JOBS = 4
/** Keys a tile's bars block lists before it counts the rest. */
const TILE_BARS = 3
const DEFAULT_TONE: Tone = 'accent'

/** A running process with its chart, as the pill and its hover card list them. */
export interface ChartEntry {
  process: BackgroundProcess
  view: ChartView
}

/** What a glance at a chart reads: its headline, else the latest figure of its first spark or meter. */
export interface Glance {
  text: string
  label?: string
  trend?: Trend
}

/** The span style a tone draws text in. */
export function toneStyle(tone: Tone | undefined): string | undefined {
  switch (tone) {
    case 'accent':

    case 'info':

    case 'user':
      return 'accent'

    case 'success':

    case 'error':

    case 'muted':
      return tone

    case 'warning':

    case 'pending':
      return 'warning'

    default:
      return undefined
  }
}

const sp = (t: string, s?: string): SpanData => (s ? { s, t } : { t })

const plain = (text: string) => text.replace(/\s+/g, ' ').trim()

const fraction = (value: number, max: number) => (!(max > 0) || !Number.isFinite(value) ? 0 : Math.min(1, Math.max(0, value / max)))

/** Props the SDK's JSX types do not know yet, spread onto an element. */
const extra = (props: Record<string, unknown>) => props as object

export function glance(view: ChartView): Glance | undefined {
  const h = view.headline

  if (h && plain(h.text)) {
    return { text: plain(h.text), ...(h.label ? { label: plain(h.label) } : {}), ...(h.trend ? { trend: h.trend } : {}) }
  }

  for (const b of view.blocks) {
    if (b.kind === 'spark' && b.values.length && plain(b.last)) {
      return { label: plain(b.label), text: plain(b.last) }
    }

    if (b.kind === 'meter' && plain(b.text)) {
      return { label: plain(b.label), text: plain(b.text) }
    }
  }

  return undefined
}

/** The entry whose live chart (one a spec drives) saw data last. */
export function latest(entries: readonly ChartEntry[]): ChartEntry | undefined {
  return entries.filter(e => e.view.state === 'live').reduce<ChartEntry | undefined>((a, e) => (!a || e.view.updatedAt > a.view.updatedAt ? e : a), undefined)
}

/** The chart as one plain line for tooltips: `load test · rps — req/s 56 ▲ 15%`. */
export function summary(view: ChartView): string {
  const g = glance(view)
  const title = plain(view.title)

  if (!g || view.state !== 'live') {
    return title
  }

  const figure = [g.label, g.text, g.trend?.text].filter(Boolean).join(' ')

  return title ? `${title} — ${figure}` : figure
}

/** Spans of a glance: muted label, strong number, toned trend. */
export function glanceSpans(g: Glance): SpanData[] {
  return [...(g.label ? [sp(`${g.label} `, 'muted')] : []), sp(g.text, 'num strong'), ...(g.trend ? [sp(` ${g.trend.text}`, toneStyle(g.trend.tone))] : [])]
}

/** The first spark cut to its newest `points` values; undefined without data. */
function primarySpark(view: ChartView, points = MINI_SPARK_POINTS): SparkBlock | undefined {
  const spark = view.blocks.find((b): b is SparkBlock => b.kind === 'spark')

  if (!spark?.values.length) {
    return undefined
  }

  if (spark.values.length <= points) {
    return spark
  }

  const from = spark.values.length - points

  return { ...spark, values: spark.values.slice(from), ...(spark.tips ? { tips: spark.tips.slice(from) } : {}) }
}

/** A spark as chart props: columns over its domain, toned reference lines, per-point tooltips. */
function sparkProps(b: SparkBlock): Record<string, unknown> {
  const marks = (b.marks ?? []).map(m => ({ value: m.value, ...(m.tone ? { tone: m.tone } : {}), ...(m.label ? { title: plain(m.label) } : {}) }))

  return {
    kind: 'bars',
    max: b.max,
    min: b.min,
    series: b.values.map((value, i) => (b.tips?.[i] ? { title: b.tips[i], value } : { value })),
    summary: `${plain(b.label)} ${plain(b.last)}`,
    token: toneStyle(b.tone ?? DEFAULT_TONE) ?? 'accent',
    ...(marks.length ? { marks } : {})
  }
}

/** The pill's mini chart: the newest values of the chart's first spark. */
export function miniSpark(view: ChartView, key = 'spark'): JSX.Element | undefined {
  const spark = view.state === 'live' ? primarySpark(view) : undefined

  return spark ? node('chart', { ...sparkProps(spark), key, role: 'omp.hud.spark', size: 'sm' }) : undefined
}

/** The hover card of the shells pill: up to four running processes as tiles, then a count of the rest. */
export function hovercard(entries: readonly ChartEntry[]): NodeJson | undefined {
  if (!entries.length) {
    return undefined
  }

  const shown = entries.slice(0, HOVERCARD_JOBS)
  const rest = entries.length - shown.length

  const card = (
    <col gap="md" role="omp.jobs.hovercard">
      {tilesNode(shown)}
      {rest > 0 ? <text key="more" role="omp.jobs.hovercard.more" spans={[sp(`+${rest} more · /ps`, 'dim')]} wrap="none" /> : null}
    </col>
  )

  return card instanceof Node ? card.toJSON() : undefined
}

/** Processes as one frame of tiles (role `omp.job.tiles`), as omp's `wait` card draws its jobs. */
export function tilesNode(entries: readonly ChartEntry[], key = 'tiles'): JSX.Element {
  return (
    <row gap="none" key={key} role="omp.job.tiles" wrap>
      {entries.map(e => tile(e))}
    </row>
  )
}

/** A figure's leading number and the unit after it: `1.10k req/s`, `7/9 trials`, `68%`. */
const FIGURE_NUMBER = /^([-+]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)[kKMGT]?%?)(?:\s+|(?=\/)|$)(.*)$/

/** `p50 41 ms ▲ 8%`: the number between its quiet label and unit, then the toned trend. */
function figureSpans(g: Glance): SpanData[] {
  const m = FIGURE_NUMBER.exec(g.text)
  const value = m?.[1] ?? g.text
  const unit = (m?.[2] ?? '').replace(/^\/\s*/, '/ ')
  const label = g.label && !unit.toLowerCase().includes(g.label.toLowerCase()) ? g.label : ''

  return [
    ...(label ? [sp(`${label} `, 'dim')] : []),
    sp(value),
    ...(unit ? [sp(` ${unit}`, 'dim')] : []),
    ...(g.trend ? [sp(` ${g.trend.text}`, toneStyle(g.trend.tone))] : [])
  ]
}

/**
 * One process as a tile (role `omp.job.tile`): a head line (status, title, id), then what a
 * live chart shows (the figure, its primary block, quiet stats) and the stage. With nothing to
 * chart, the stage is the tile's body.
 */
export function tile({ process: p, view }: ChartEntry): JSX.Element {
  const live = view.state === 'live' ? view : undefined
  const g = live && glance(live)
  const title = plain(live?.title ?? '') || plain(p.command.split(/\r?\n/, 1)[0] ?? '') || p.id
  const visual = tileVisual(live?.blocks[0])
  const look = PROCESS_LOOK[p.status]

  return (
    <col gap="xs" key={p.id} role="omp.job.tile" tone={look.tone}>
      <row align="center" gap="xs" key="head" role="omp.job.tile.head">
        <text
          key="dot"
          role="omp.job.tile.dot"
          spans={[{ s: toneStyle(look.tone), t: look.glyph, ...(p.status === 'running' ? { fx: 'pulse' } : {}) }]}
          wrap="none"
        />
        <text grow={1} key="title" role="omp.job.tile.title" spans={[sp(title)]} truncate="end" wrap="none" />
        <text key="id" role="omp.job.tile.id" spans={[sp(p.id, 'dim')]} wrap="none" />
      </row>
      {g ? <text key="figure" role="omp.job.tile.figure" spans={figureSpans(g)} truncate="end" wrap="none" /> : null}
      {visual}
      {tileNotes(p, view, live, !g && !visual)}
    </col>
  )
}

function tileMeter(value: number, tone: Tone = DEFAULT_TONE, key = 'meter'): JSX.Element {
  return <meter grow={1} key={key} role="omp.job.tile.meter" size="sm" tone={tone} value={fraction(value, 1)} />
}

/** A tile's picture of its primary block; stats and text read as notes instead. */
function tileVisual(b: Block | undefined): JSX.Element | undefined {
  switch (b?.kind) {
    case 'spark':
      return b.values.length ? node('chart', { ...sparkProps(b), key: 'visual', role: 'omp.job.tile.chart', size: 'sm' }) : undefined

    case 'meter':
      return tileMeter(b.value, b.tone, 'visual')

    case 'bars': {
      const rest = b.items.length - TILE_BARS

      return b.items.length ? (
        <col gap="xs" key="visual" role="omp.job.tile.bars">
          {b.items.slice(0, TILE_BARS).map((item, i) => (
            <row align="center" gap="sm" key={`${i}`} role="omp.job.tile.bar">
              <text key="key" role="omp.job.tile.key" spans={[sp(plain(item.label), 'dim')]} truncate="end" wrap="none" />
              {tileMeter(fraction(item.value, b.max), item.tone)}
              <text key="num" role="omp.job.tile.num" spans={[sp(plain(item.text))]} wrap="none" />
            </row>
          ))}
          {rest > 0 ? <text key="more" role="omp.job.tile.more" spans={[sp(`+${rest} more`, 'dim')]} wrap="none" /> : null}
        </col>
      ) : undefined
    }

    case 'grid':
      // No-break spaces inside a cell: lines wrap between cells only.
      return b.items.length ? (
        <text
          key="visual"
          role="omp.job.tile.grid"
          spans={b.items.flatMap((item, i) => [
            ...(i ? [sp('   ')] : []),
            sp('● ', toneStyle(item.tone)),
            sp(plain(item.label).replaceAll(' ', ' '), 'dim')
          ])}
          wrap="word"
        />
      ) : undefined

    default:
      return undefined
  }
}

/** The live chart's stats and text lines, then the stage (the tile's body when nothing charts). */
function tileNotes(p: BackgroundProcess, view: ChartView, live: ChartView | undefined, lead: boolean): JSX.Element[] {
  // A live chart's stage is a line no rule read; the matched lines are what its figures show.
  const stage = plain(view.stage ?? '')
  const failed = p.exitCode ? `exit ${p.exitCode}` : ''
  const notes: JSX.Element[] = []

  for (const b of live?.blocks ?? []) {
    if (b.kind === 'stat' && b.items.length) {
      notes.push(<text key={`note-${notes.length}`} role="omp.job.tile.stats" spans={statSpans(b)} truncate="end" wrap="none" />)
    } else if (b.kind === 'text' && plain(b.text) && plain(b.text) !== stage) {
      notes.push(<text key={`note-${notes.length}`} role="omp.job.tile.note" spans={[sp(plain(b.text), 'dim')]} truncate="end" wrap="none" />)
    }
  }

  if (stage || failed) {
    const spans = [...(failed ? [sp(failed, 'error')] : []), ...(failed && stage ? [sp(' · ', 'dim')] : []), ...(stage ? [sp(stage, lead ? 'mono' : 'dim mono')] : [])]
    notes.push(
      lead ? (
        <text key="stage" lines={3} role="omp.job.tile.lead" spans={spans} truncate="end" wrap="word" />
      ) : (
        <text key="stage" role="omp.job.tile.stage" spans={spans} truncate="end" wrap="none" />
      )
    )
  }

  return notes
}

/** `p50 41 ms ▼ 12% · errors 0`: dim labels, values in their tone, toned trends. */
function statSpans(b: StatBlock): SpanData[] {
  return b.items.flatMap((item, i) => [
    ...(i ? [sp(' · ', 'dim')] : []),
    sp(`${plain(item.label)} `, 'dim'),
    sp(plain(item.text), toneStyle(item.tone)),
    ...(item.trend ? [sp(` ${item.trend.text}`, toneStyle(item.trend.tone))] : [])
  ])
}

/** The whole chart (role `omp.job.widget`), as the Background sheet shows it: a head row over every block. */
export function chartNode(view: ChartView, key = 'chart'): JSX.Element {
  const stage = view.stage ? plain(view.stage) : ''
  const h = view.state === 'live' ? glance({ ...view, blocks: [] }) : undefined

  return (
    <col gap="xs" key={key} role="omp.job.widget">
      <row align="baseline" gap="sm" key="head" role="omp.job.widget.head">
        <text key="title" role="omp.job.widget.title" spans={[sp(plain(view.title), 'strong')]} truncate="end" wrap="none" {...extra(stage ? {} : { grow: 1 })} />
        {stage ? <text grow={1} key="stage" role="omp.job.widget.stage" spans={[sp(stage, 'muted')]} truncate="end" wrap="none" /> : null}
        {view.state === 'authoring' ? <shimmer key="authoring" text="charting…" /> : null}
        {h ? <text key="headline" role="omp.job.widget.headline" spans={glanceSpans(h)} wrap="none" /> : null}
      </row>
      {view.state === 'live' ? view.blocks.map((b, i) => blockNode(b, `${i}-${b.kind}`)) : null}
    </col>
  )
}

/** The chart's primary block alone, for a background terminal card. */
export function primaryNode(view: ChartView, key = 'chart'): JSX.Element | undefined {
  const b = view.state === 'live' ? view.blocks[0] : undefined

  return b ? <col key={key} role="omp.job.widget">{blockNode(b, 'primary')}</col> : undefined
}

function blockNode(b: Block, key: string): JSX.Element {
  switch (b.kind) {
    case 'spark':
      return sparkNode(b, key)

    case 'bars':
      return (
        <col gap="xs" key={key} role="omp.job.widget.bars">
          <text key="caption" role="omp.job.widget.caption" spans={[sp(plain(b.label), 'dim')]} truncate="end" wrap="none" />
          {b.items.length
            ? b.items.map((item, i) =>
                labelled(
                  item.label,
                  <meter grow={1} key="meter" label={plain(item.text)} size="sm" value={fraction(item.value, b.max)} {...extra(item.tone ? { tone: item.tone } : {})} />,
                  'omp.job.widget.bar',
                  `${i}`
                )
              )
            : waiting()}
        </col>
      )

    case 'meter':
      return labelled(
        b.label,
        <meter grow={1} key="meter" label={plain(b.text)} size="sm" value={fraction(b.value, 1)} {...extra(b.tone ? { tone: b.tone } : {})} />,
        'omp.job.widget.meter',
        key
      )

    case 'stat':
      return <text key={key} role="omp.job.widget.stat" spans={statSpans(b)} truncate="end" wrap="none" />

    case 'grid':
      return (
        <col gap="xs" key={key} role="omp.job.widget.grid">
          <text key="caption" role="omp.job.widget.caption" spans={[sp(plain(b.label), 'dim')]} truncate="end" wrap="none" />
          {b.items.length ? (
            <row gap="xs" key="cells" role="omp.job.widget.cells" wrap>
              {b.items.map((item, i) => (
                <badge key={`${i}`} text={plain(item.label)} title={plain(item.text)} tone={item.tone} />
              ))}
            </row>
          ) : (
            waiting()
          )}
        </col>
      )

    case 'text':
      return <text key={key} role="omp.job.widget.text" spans={[sp(plain(b.text), 'muted')]} truncate="end" wrap="none" />
  }
}

/** A column chart with dashed reference lines, the latest value and the mark labels at its side. */
function sparkNode(b: SparkBlock, key: string): JSX.Element {
  if (!b.values.length) {
    return labelled(b.label, waiting(), 'omp.job.widget.spark', key)
  }

  const label = plain(b.label)
  const last = plain(b.last)

  return (
    <row align="center" gap="sm" key={key} role="omp.job.widget.spark">
      {node('chart', { ...sparkProps(b), grow: 1, key: 'chart', size: 'md' })}
      <col gap="none" key="side" role="omp.job.widget.side">
        <text key="last" spans={[sp(last, 'num strong')]} wrap="none" />
        {label && !last.endsWith(label) ? <text key="label" spans={[sp(label, 'muted')]} truncate="end" wrap="none" /> : null}
        {(b.marks ?? []).map((m, i) => (
          <text key={`mark-${i}`} spans={[sp('┄ ', toneStyle(m.tone ?? 'muted')), sp(plain(m.label), 'dim')]} truncate="end" wrap="none" />
        ))}
      </col>
    </row>
  )
}

/** A label column (12 cells, muted) before `content`. */
function labelled(label: string, content: JSX.Element, role: string, key: string): JSX.Element {
  return (
    <row align="center" gap="sm" key={key} role={role}>
      <text key="label" max={{ w: '12ch' }} min={{ w: '12ch' }} spans={[sp(plain(label), 'muted')]} truncate="end" wrap="none" />
      {content}
    </row>
  )
}

function waiting(): JSX.Element {
  return <text key="waiting" spans={[sp('waiting for data', 'dim')]} wrap="none" />
}
