import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { analyzeTable, TableCharts } from '../transcript/tableCharts.js'
import { hermesTableChartPlanner, readTableChartReply, TABLE_CHART_DEADLINE_MS } from '../transcript/tableChartPlanner.js'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const FIXTURE = join(REPO, 'tests', 'fixtures', 'table_charts')
const TABLE = '| Category | Revenue |\n| --- | --- |\n| Alpha | 10 |\n| Beta | 25 |'
const parsed = analyzeTable(TABLE)

function route(scenario: string, expectRedaction = false) {
  // The actual shipped adapter launches the actual shipped Python script;
  // PYTHONPATH resolves fixture providers, not credentials or a live model.
  return hermesTableChartPlanner({
    ...process.env,
    HERMES_TERN_HERMES: JSON.stringify({
      argv: ['python3', '-m', 'hermes_cli.main'],
      env: {
        PYTHONPATH: FIXTURE,
        TABLE_CHART_FIXTURE_OUTPUT: scenario,
        TABLE_CHART_FIXTURE_EXPECT_REDACTION: expectRedaction ? '1' : '0'
      }
    })
  })
}

describe('table chart Python auxiliary transport (fixture provider)', () => {
  it.each(['bar', 'line', 'none'] as const)('uses the configured task and accepts only %s', async kind => {
    expect(parsed).toBeDefined()
    if (!parsed) { return }
    await expect(route(kind)('owned-session', parsed, new AbortController().signal)).resolves.toBe(kind)
  })

  it('redacts source before the single local provider send', async () => {
    const sensitive = analyzeTable(TABLE.replace('| Alpha |', '| secret |'))
    expect(sensitive).toBeDefined()
    if (!sensitive) { return }
    await expect(route('line', true)('owned-session', sensitive, new AbortController().signal)).resolves.toBe('line')
  })

  it.each(['invalid content', '<svg>unsafe</svg>', 'raise', 'unavailable', 'unsafe'])('keeps the local bar for %s', async reply => {
    expect(parsed).toBeDefined()
    if (!parsed) { return }
    await expect(route(reply)('owned-session', parsed, new AbortController().signal)).resolves.toBe('bar')
  })

  it('rejects forged reply envelopes', () => {
    expect(() => readTableChartReply('{"kind":"line","svg":"<script />"}')).toThrow()
    expect(() => readTableChartReply('{"kind":"scatter"}')).toThrow()
    expect(() => readTableChartReply('not JSON')).toThrow()
    expect(readTableChartReply('helper diagnostics\n{"kind":"line"}')).toBe('line')
  })

  it('never starts Python in off or always mode', () => {
    const planner = vi.fn(route('line'))
    const charts = new TableCharts({ policy: async () => 'off', plan: planner }, () => undefined)

    charts.configure('off')
    charts.markdown(TABLE, true)
    charts.configure('always')
    expect(charts.markdown(TABLE, true)).toContain('<rect')
    expect(planner).not.toHaveBeenCalled()
  })

  it('kills a pending provider on session or policy replacement', async () => {
    expect(parsed).toBeDefined()
    if (!parsed) { return }
    const cancel = new AbortController()
    const pending = route('slow')('owned-session', parsed, cancel.signal)
    cancel.abort()
    await expect(pending).rejects.toThrow()
  })

  it('enforces an absolute five-second deadline, including the subprocess', async () => {
    expect(parsed).toBeDefined()
    if (!parsed) { return }
    const started = Date.now()
    await expect(route('slow')('owned-session', parsed, new AbortController().signal)).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(TABLE_CHART_DEADLINE_MS + 2500)
    expect(Date.now() - started).toBeGreaterThanOrEqual(TABLE_CHART_DEADLINE_MS - 1000)
  }, 9000)
})
