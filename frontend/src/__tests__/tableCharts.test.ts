import { describe, expect, it, vi } from 'vitest'

import { entryId } from '../core/ids.js'
import type { TurnEntry } from '../model.js'
import { answerText } from '../transcript/turns.js'
import {
  analyzeTable,
  chartSvg,
  type ChartKind,
  type ChartMode,
  TableCharts,
  tableSlices
} from '../transcript/tableCharts.js'
import { settingsOf } from '../wire/files.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'

import { tree } from './fakes.js'

const TABLE = '| Category | Revenue |\n| --- | ---: |\n| Alpha | 10 |\n| Beta | 25 |'
const FENCE = String.fromCharCode(96).repeat(3)

const flush = () => new Promise<void>(resolve => setImmediate(resolve))

function controller(mode: ChartMode, plan: (session: string, table: NonNullable<ReturnType<typeof analyzeTable>>) => Promise<ChartKind> = async () => 'line') {
  const changed = vi.fn()
  const charts = new TableCharts({ policy: async () => mode, plan }, changed)
  charts.configure(mode)

  return { charts, changed }
}

function turn(text: string, status: 'live' | 'done' | 'error' = 'done'): TurnEntry {
  return {
    blocks: [{ id: entryId('block'), kind: 'text', text }],
    end: status === 'error' ? { status, error: 'failed' } : { status },
    id: entryId('turn'),
    kind: 'turn',
    rev: 1,
    startedAt: 0
  }
}

function rendered(t: TurnEntry, charts: TableCharts): string {
  const cx: TranscriptContext = {
    charts,
    copy: () => undefined,
    now: 100,
    welcome: { version: '' }
  }

  return JSON.stringify(tree(entryNode(t, 'main.turn', cx)))
}

describe('automatic table charts: conservative analysis', () => {
  it('accepts just two-column finite decimal or consistent percentage values', () => {
    const numeric = analyzeTable(TABLE)

    expect(numeric).toEqual({ labels: ['Alpha', 'Beta'], source: TABLE, title: 'Revenue', values: [10, 25] })
    expect(Object.isFrozen(numeric)).toBe(true)
    expect(Object.isFrozen(numeric?.values)).toBe(true)
    expect(analyzeTable(TABLE.replace('10 |', '10% |').replace('25 |', '25% |'))?.values).toEqual([10, 25])
    expect(analyzeTable(TABLE.replace('10 |', '-10 |'))?.values).toEqual([-10, 25])
  })

  it.each([
    TABLE.replace('25 |', 'unknown |'),
    TABLE.replace('| Beta | 25 |', '| Beta |'),
    TABLE.replace('Beta', 'Alpha'),
    TABLE.replace('Alpha', '2025'),
    TABLE.replace('25 |', '25% |'),
    TABLE.replace('25 |', '1,234 |'),
    TABLE.replace('25 |', 'Infinity |'),
    TABLE.replace('25 |', '1e99 |'),
    TABLE.replace('25 |', '0 |').replace('10 |', '0 |'),
    TABLE.replace('Beta', 'bad\\pipe'),
    '| Label | A | B |\n| --- | --- | --- |\n| x | 1 | 2 |\n| y | 2 | 3 |',
    TABLE + '\n| X | 2 |'.repeat(25)
  ])('rejects unsupported, malformed or ambiguous tables: %s', source => {
    expect(analyzeTable(source)).toBeUndefined()
  })

  it('skips fenced, indented-code and oversized source, with bounded candidate count', () => {
    expect(tableSlices(FENCE + 'md\n' + TABLE + '\n' + FENCE)).toEqual([])
    expect(tableSlices('    ' + TABLE.replaceAll('\n', '\n    '))).toEqual([])
    expect(tableSlices('x'.repeat(65537) + TABLE)).toEqual([])
    expect(tableSlices(Array.from({ length: 10 }, () => TABLE).join('\n\n'))).toHaveLength(8)
    expect(analyzeTable(TABLE + ' '.repeat(8193))).toBeUndefined()
  })

  it('escapes source labels and defers colors to the terminal palette', () => {
    const parsed = analyzeTable(TABLE.replace('Alpha', 'A & B').replace('Beta', 'B "2"'))

    expect(parsed).toBeDefined()
    if (!parsed) { return }
    const svg = chartSvg(parsed, 'bar')

    expect(svg).toContain('A &amp; B')
    expect(svg).toContain('B &quot;2&quot;')
    expect(svg).toContain('var(--accent)')
    expect(svg).toContain('var(--text)')
    expect(svg).not.toContain('<script')
    expect(svg).not.toMatch(/#[a-f0-9]{3,8}/i)
  })
})

describe('automatic table charts: per-session planning', () => {
  it('defaults off, never changes the answer or invokes a planner while off/streaming', () => {
    const plan = vi.fn(async (): Promise<ChartKind> => 'line')
    const { charts } = controller('off', plan)

    expect(charts.markdown(TABLE, true)).toBe(TABLE)
    charts.configure('smart')
    expect(charts.markdown(TABLE, false)).toBe(TABLE)
    charts.configure('off')
    expect(plan).not.toHaveBeenCalled()
  })

  it('appends local SVG without a model call, preserves each original table and reuses plans', async () => {
    const plan = vi.fn(async (): Promise<ChartKind> => 'line')
    const { charts } = controller('always', plan)
    const markdown = TABLE + '\n\n' + TABLE
    const output = charts.markdown(markdown, true)

    expect(output.split(TABLE)).toHaveLength(3)
    expect(output.split(FENCE + 'svg')).toHaveLength(3)
    expect(output).toContain('<rect')
    expect(plan).not.toHaveBeenCalled()

    charts.configure('smart')
    charts.markdown(markdown, true)
    await flush()
    expect(plan).toHaveBeenCalledOnce()
    expect(charts.markdown(markdown, true)).toContain('<polyline')
  })

  it('keeps local fallback when smart planning fails, is invalid or reaches the budget', async () => {
    const bad = controller('smart', async () => { throw new Error('no backend route') }).charts

    bad.markdown(TABLE, true)
    await flush()
    expect(bad.markdown(TABLE, true)).toContain('<rect')

    const invalid = controller('smart', async () => 'none').charts
    invalid.markdown(TABLE, true)
    await flush()
    expect(invalid.markdown(TABLE, true)).not.toContain(FENCE + 'svg')

    const plan = vi.fn(async (): Promise<ChartKind> => 'line')
    const { charts } = controller('smart', plan)

    for (let n = 0; n < 12; n++) {
      charts.markdown(TABLE.replace('Revenue', 'Revenue ' + n), true)
      await flush()
    }

    expect(plan).toHaveBeenCalledTimes(8)
    expect(charts.markdown(TABLE.replace('Revenue', 'Revenue 11'), true)).toContain('<rect')
  })

  it('ignores a delayed plan after a mode or session switch', async () => {
    const late = Promise.withResolvers<ChartKind>()
    const plan = vi.fn(() => late.promise)
    const { charts } = controller('smart', plan)

    charts.markdown(TABLE, true)
    await flush()
    expect(plan).toHaveBeenCalledOnce()
    charts.configure('off')
    late.resolve('line')
    await flush()
    expect(charts.markdown(TABLE, true)).toBe(TABLE)

    charts.configure('always')
    expect(charts.markdown(TABLE, true)).toContain('<rect')
    charts.session('new-session')
    await flush()
    charts.configure('always')
    expect(charts.markdown(TABLE, true)).toContain('<rect')
  })

  it('drops outdated asynchronous policy answers after a session switch', async () => {
    const first = Promise.withResolvers<ChartMode>()
    const second = Promise.withResolvers<ChartMode>()
    const changed = vi.fn()
    const charts = new TableCharts({
      policy: s => s === 'old' ? first.promise : second.promise,
      plan: async () => 'line'
    }, changed)

    charts.session('old')
    charts.session('new')
    first.resolve('always')
    await flush()
    expect(charts.mode).toBe('off')
    second.resolve('smart')
    await flush()
    expect(charts.mode).toBe('smart')
    charts.close()
  })
})

describe('automatic table charts: transcript rendering', () => {
  it('projects only complete assistant answers, never streamed or failed turns', () => {
    const { charts } = controller('always')
    const t = turn(TABLE, 'live')

    expect(rendered(t, charts)).not.toContain(FENCE + 'svg')
    t.end = { status: 'done' }
    t.rev++
    expect(rendered(t, charts)).toContain(FENCE + 'svg')
    expect(answerText(t)).toBe(TABLE)
    t.end = { status: 'error', error: 'failed' }
    t.rev++
    expect(rendered(t, charts)).not.toContain(FENCE + 'svg')
  })

  it('invalidates entry-node memoization when async smart planning or policy changes', async () => {
    const { charts } = controller('smart')
    const t = turn(TABLE)

    expect(rendered(t, charts)).toContain('<rect')
    await flush()
    expect(rendered(t, charts)).toContain('<polyline')
    charts.configure('off')
    expect(rendered(t, charts)).not.toContain(FENCE + 'svg')
    expect(answerText(t)).toBe(TABLE)
  })

  it('validates the persisted policy, discarding invalid values', () => {
    expect(settingsOf({ tableCharts: 'always' })).toMatchObject({ tableCharts: 'always' })
    expect(settingsOf({ tableCharts: 'smart' })).toMatchObject({ tableCharts: 'smart' })
    expect(settingsOf({ tableCharts: 'unsafe' }).tableCharts).toBeUndefined()
  })
})

describe('automatic table charts: strict auxiliary ownership', () => {
  it('aborts a stale provider without admitting concurrent work on policy replacement', async () => {
    const late = Promise.withResolvers<ChartKind>()
    let signal: AbortSignal | undefined
    const plan = vi.fn((_session: string, _table: NonNullable<ReturnType<typeof analyzeTable>>, active: AbortSignal) => {
      signal = active

      return late.promise
    })
    const charts = new TableCharts({ policy: async () => 'smart', plan }, () => undefined)
    charts.configure('smart')
    charts.markdown(TABLE, true)
    await flush()
    expect(plan).toHaveBeenCalledOnce()

    charts.configure('smart')
    expect(signal?.aborted).toBe(true)
    charts.markdown(TABLE.replace('Revenue', 'Revenue 2'), true)
    await flush()
    expect(plan).toHaveBeenCalledOnce()

    late.resolve('line')
    await flush()
    charts.markdown(TABLE.replace('Revenue', 'Revenue 2'), true)
    await flush()
    expect(plan).toHaveBeenCalledTimes(2)
  })

  it('retires results on transport loss and keeps the local presentation unchanged', async () => {
    const late = Promise.withResolvers<ChartKind>()
    let signal: AbortSignal | undefined
    const charts = new TableCharts({
      policy: async () => 'smart',
      plan: (_session, _table, active) => {
        signal = active

        return late.promise
      }
    }, () => undefined)

    charts.configure('smart')
    expect(charts.markdown(TABLE, true)).toContain('<rect')
    await flush()
    charts.transportLost()
    expect(signal?.aborted).toBe(true)
    late.resolve('line')
    await flush()
    expect(charts.markdown(TABLE, true)).toBe(TABLE)
    charts.configure('always')
    expect(charts.markdown(TABLE, true)).toContain('<rect')
  })
})
