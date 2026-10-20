import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { toolCallId } from '../core/ids.js'
import type { BackgroundProcess, ToolCall } from '../model.js'
import { linkCalls } from '../processes/store.js'
import { isWatchCall } from '../transcript.js'
import { promptSources, renderPrompt, SYSTEM_PROMPT } from '../processes/widgets/author.js'
import { formatNumber, formatRatio, formatTrend } from '../processes/widgets/format.js'
import { FileTap, outputFiles } from '../processes/widgets/files.js'
import { chartMemory } from '../processes/widgets/memory.js'
import { Charts, OutputTap } from '../processes/widgets/registry.js'
import { ChartRuntime, sparkDomain } from '../processes/widgets/runtime.js'
import { compilePattern, parseValue, type Spec, validateSpec } from '../processes/widgets/spec.js'
import type { SparkBlock, StatBlock } from '../processes/widgets/types.js'
import { glance, hovercard, miniSpark, summary } from '../processes/widgets/view.js'

const LOAD: Spec = {
  blocks: [
    { better: 'higher', field: 'rps', kind: 'spark', label: 'req/s', target: 60, targetLabel: 'goal 60', unit: 'req/s' },
    { items: [{ agg: 'last', better: 'lower', field: 'p50', label: 'p50', unit: 'ms' }], kind: 'stat' }
  ],
  headline: { agg: 'last', better: 'higher', field: 'rps', unit: 'req/s' },
  rules: [{ from: 'out', match: '^req \\d+ rps=(?P<rps>[\\d.]+) p50=(?P<p50>[\\d.]+)ms' }],
  title: 'load test · rps'
}

const lines = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `req ${from + i} rps=${50 + from + i} p50=${40 - i}ms`).join('\n') + '\n'

/** A source whose whole text is `text`. */
const source = (text: string) => ({ id: 'out', label: 'bench', read: (from: number) => ({ end: text.length, open: true, start: from, text: text.slice(from) }) })

const proc = (over: Partial<BackgroundProcess> = {}): BackgroundProcess => ({
  command: 'bench --goal 60',
  id: 'proc_1',
  lastLine: '',
  output: '',
  startedAt: 0,
  status: 'running',
  ...over
})

describe('job chart formatting', () => {
  it('compacts large numbers and attaches %', () => {
    expect(formatNumber(4096)).toBe('4096')
    expect(formatNumber(12_345, 'req')).toBe('12.3k req')
    expect(formatNumber(41.25, 'ms')).toBe('41.3 ms')
    expect(formatNumber(68, '%')).toBe('68%')
  })

  it('scales bytes and times to a readable unit', () => {
    expect(formatNumber(1.8e9, 'B')).toBe('1.8 GB')
    expect(formatNumber(43_200_000, 'bytes')).toBe('43.2 MB')
    expect(formatNumber(959_000, 'ms')).toBe('16 min')
    expect(formatNumber(348, 'ms')).toBe('348 ms')
    expect(formatNumber(7200, 's')).toBe('2 h')
    expect(formatRatio(1.2e9, 1.8e9, 'B')).toBe('1.2/1.8 GB')
    expect(formatRatio(7, 9, 'trials')).toBe('7/9 trials')
  })

  it('reads a large move as a factor', () => {
    expect(formatTrend(5000, 959_000, 'lower')).toEqual({ text: '▲ 192×', tone: 'error' })
  })

  it('tones a trend toward or away from better', () => {
    expect(formatTrend(100, 115, 'higher')).toEqual({ text: '▲ 15%', tone: 'success' })
    expect(formatTrend(100, 115, 'lower')).toEqual({ text: '▲ 15%', tone: 'error' })
    expect(formatTrend(5, 5, 'higher')).toBeUndefined()
  })

  it('reads separators and suffixes', () => {
    expect(parseValue('1,234')).toBe(1234)
    expect(parseValue('4.5k')).toBe(4500)
    expect(parseValue('ok')).toBeNaN()
  })
})

describe('job chart specs', () => {
  it('accepts a spec whose rules match the samples and whose target the command states', () => {
    const samples = [{ id: 'out', lines: lines(5).trim().split('\n') }]

    expect(validateSpec(LOAD, samples, 'bench --goal 60')).toEqual({ ok: true, spec: LOAD })
  })

  it('rejects rules that match nothing, invented targets and unknown fields', () => {
    const samples = [{ id: 'out', lines: ['nothing to see'] }]
    const bad = validateSpec({ ...LOAD, rules: [{ from: 'out', match: '^x (?P<rps>\\d+) (?P<p50>\\d+)' }] }, samples, 'bench')
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.errors.join('\n')).toMatch(/no rule matches/)

    const invented = validateSpec(LOAD, [{ id: 'out', lines: lines(3).trim().split('\n') }], 'bench')
    expect(!invented.ok && invented.errors.join('\n')).toMatch(/target: 60 appears nowhere/)

    const unknown = validateSpec({ ...LOAD, headline: { agg: 'last', field: 'tps' } })
    expect(!unknown.ok && unknown.errors.join('\n')).toMatch(/unknown field "tps"/)
  })

  it('reads model text written HTML-escaped', () => {
    const r = validateSpec({ ...LOAD, title: 'ACL &amp; update tests' })

    expect(r.ok && r.spec.title).toBe('ACL & update tests')
  })

  it('turns a meter without a known total into a stat', () => {
    const r = validateSpec({ blocks: [{ agg: 'last', field: 'rps', kind: 'meter', label: 'rps', total: '?' }], rules: LOAD.rules, title: 't' })

    expect(r.ok && r.spec.blocks[0]!.kind).toBe('stat')
  })

  it('compiles patterns to run in linear time, refusing lookaround and backreferences', () => {
    const re = compilePattern('^(?P<a>(x+x+)+)y$')
    const start = performance.now()
    expect(re.exec(`${'x'.repeat(5000)}z`)).toBeNull()
    expect(performance.now() - start).toBeLessThan(500)
    expect(() => compilePattern('(?=a)b')).toThrow(/lookaround or backreferences/)
    expect(() => compilePattern('(a)\\1')).toThrow(/lookaround or backreferences/)
  })
})

describe('job chart runtime', () => {
  it('derives the spark, marks, stats and headline from the lines', () => {
    const rt = new ChartRuntime(LOAD, 0, () => 1000)
    rt.ingest([source(lines(4))], false)
    const view = rt.view({ authoring: false, label: 'bench' })

    expect(view.state).toBe('live')
    expect(view.headline).toEqual({ text: '54 req/s', trend: { text: '▲ 5.9%', tone: 'success' } })
    const spark = view.blocks[0] as SparkBlock
    expect(spark.values).toEqual([51, 52, 53, 54])
    expect(spark.marks).toEqual([{ label: 'goal 60', tone: 'muted', value: 60 }])
    expect(spark.min).toBeLessThan(51)
    expect(spark.max).toBeGreaterThan(60)
    expect((view.blocks[1] as StatBlock).items[0]).toEqual({ label: 'p50', text: '37 ms', trend: { text: '▼ 7.5%', tone: 'success' } })
  })

  it('falls back to line counts and the last line without a spec', () => {
    const rt = new ChartRuntime(undefined, 0, () => 2000)
    rt.ingest([source('one\ntwo\nthree\n')], false)
    const view = rt.view({ authoring: true, label: 'bench   --x' })

    expect(view).toMatchObject({ stage: 'three', state: 'authoring', title: 'bench --x' })
    expect(view.blocks).toEqual([{ items: [{ label: 'lines', text: '3' }, { label: 'lines/s', text: '1.50' }], kind: 'stat' }])
  })

  it('pads a flat series so it does not draw as a full bar', () => {
    expect(sparkDomain([100, 100])).toEqual({ max: 105, min: 95 })
    expect(sparkDomain([], 0, 10)).toEqual({ max: 10, min: 0 })
  })
})

describe('OutputTap', () => {
  it('turns sliding windows into an append-only stream, and a lost window into a gap', () => {
    const stream = Array.from({ length: 400 }, (_, i) => `line ${i}\n`).join('')
    const tap = new OutputTap('cmd')
    tap.update(stream.slice(0, 1000))
    tap.update(stream.slice(0, 2000))
    expect(tap.read(0)).toEqual({ end: 2000, open: true, start: 0, text: stream.slice(0, 2000) })

    // The window slid (the store keeps only the newest part): the old end is found in the new one.
    tap.update(stream.slice(1500, 3000))
    expect(tap.read(2000).text).toBe(stream.slice(2000, 3000))
    // A shorter tail of the same output adds nothing.
    tap.update(stream.slice(2900, 3000))
    expect(tap.read(3000).text).toBe('')

    // Nothing of the old window is left: the reader sees a gap.
    tap.update('zzz\ny\n')
    const chunk = tap.read(3000)
    expect(chunk.start).toBeGreaterThan(3000)
    expect(chunk.text).toBe('zzz\ny\n')
  })
})

describe('OutputTap edge cases', () => {
  const kept = (tap: OutputTap) => tap.read(0).text

  it('follows 200-character previews without counting them twice', () => {
    const stream = Array.from({ length: 200 }, (_, i) => `l${i}\n`).join('')
    const tap = new OutputTap('cmd')

    for (let end = 200; end <= stream.length; end += 37) {
      tap.update(stream.slice(end - 200, end))
    }

    const last = Math.floor((stream.length - 200) / 37) * 37 + 200
    expect(kept(tap)).toBe(stream.slice(0, last))
  })

  it('ignores a poll older than what it holds, and takes streamed chunks exactly', () => {
    const tap = new OutputTap('cmd')
    tap.update('a\nb\nc\nd\n')
    tap.update('b\nc\n')
    expect(kept(tap)).toBe('a\nb\nc\nd\n')

    // Repeated identical lines: chunks count each one; windows are then ignored.
    tap.append('wait\n')
    tap.append('wait\n')
    tap.update('wait\nwait\n')
    expect(kept(tap)).toBe('a\nb\nc\nd\nwait\nwait\n')
  })
})

describe('Charts', () => {
  it('asks the author once the process is old and talkative enough, then draws live', async () => {
    let now = 1000
    const asked: string[] = []
    let changed = 0
    const charts = new Charts(() => changed++, {
      author: async request => {
        asked.push(request.command)

        return LOAD
      },
      now: () => now
    })

    const p = proc({ output: lines(5) })
    expect(charts.view(p)?.state).toBe('fallback')
    expect(asked).toEqual([])

    now = 20_000
    expect(charts.view(p)?.state).toBe('authoring')
    await new Promise(r => setTimeout(r, 0))
    expect(asked).toEqual(['bench --goal 60'])
    expect(changed).toBe(2)

    now += 1000
    const view = charts.view(p)!
    expect(view.state).toBe('live')
    expect((view.blocks[0] as SparkBlock).values).toHaveLength(5)
    // Unchanged data keeps the view's identity, so the store does not relink cards.
    now += 1000
    expect(charts.view(p)).toBe(view)
  })

  it('retries once with the errors, then stops after a skip', async () => {
    let now = 20_000
    const requests: (string[] | undefined)[] = []
    const charts = new Charts(() => undefined, {
      author: async request => {
        requests.push(request.rejected?.errors)

        return requests.length === 1 ? { ...LOAD, rules: [{ from: 'out', match: '^nope (?P<rps>\\d+) (?P<p50>\\d+)' }] } : { skip: 'no numbers' }
      },
      now: () => now
    })

    charts.view(proc({ output: lines(5) }))
    await new Promise(r => setTimeout(r, 0))
    expect(requests).toHaveLength(2)
    expect(requests[1]?.join()).toMatch(/no rule matches/)

    now += 60_000
    expect(charts.view(proc({ output: lines(9) }))?.state).toBe('fallback')
    expect(requests).toHaveLength(2)
  })

  it('settles a chart whose process exits while its rules are being written', async () => {
    let now = 20_000
    let release: (v: unknown) => void = () => undefined
    const charts = new Charts(() => undefined, { author: () => new Promise(r => (release = r)), now: () => now })
    const p = proc({ output: lines(5) })

    expect(charts.view(p)?.state).toBe('authoring')
    p.status = 'done'
    now += 1000
    expect(charts.view(p)?.state).toBe('fallback')
    release(LOAD)
    await new Promise(r => setTimeout(r, 0))
    expect(charts.view(p)?.state).toBe('fallback')
  })

  it('freezes when the process exits and draws nothing when turned off', () => {
    const charts = new Charts(() => undefined, { enabled: () => false })
    expect(charts.view(proc())).toBeUndefined()

    const on = new Charts(() => undefined)
    const p = proc({ output: 'one\n', status: 'done' })
    const view = on.view(p)
    p.output = 'one\ntwo\n'
    expect(on.view(p)).toBe(view)
  })
})

describe('job chart views', () => {
  const live = () => {
    const rt = new ChartRuntime(LOAD, 0, () => 1000)
    rt.ingest([source(lines(3))], false)

    return rt.view({ authoring: false, label: 'bench' })
  }

  it('glances at the headline and summarizes for tooltips', () => {
    expect(glance(live())).toEqual({ text: '53 req/s', trend: { text: '▲ 3.9%', tone: 'success' } })
    expect(summary(live())).toBe('load test · rps — 53 req/s ▲ 3.9%')
  })

  it('draws the mini chart with the target line, Tern 0.9.5 chart props', () => {
    const spark = miniSpark(live())!

    expect(spark).toMatchObject({ kind: 'chart' })
    expect((spark as { props: Record<string, unknown> }).props).toMatchObject({
      kind: 'bars',
      marks: [{ title: 'goal 60', tone: 'muted', value: 60 }],
      role: 'omp.hud.spark',
      series: [51, 52, 53].map(value => ({ title: expect.stringContaining(`${value} req/s`), value })),
      size: 'sm'
    })
  })

  it('builds the hover card as a plain node tree, one tile per process', () => {
    const card = hovercard([
      { process: proc(), view: live() },
      { process: proc({ command: 'sleep 99', id: 'proc_2' }), view: { blocks: [], stage: 'waiting', state: 'fallback', title: 'sleep 99', updatedAt: 0 } }
    ])!

    expect(card.k).toBe('col')
    const tiles = card.c![0]!
    expect(tiles.p).toMatchObject({ role: 'omp.job.tiles' })
    expect(tiles.c!.map(t => t.p?.role)).toEqual(['omp.job.tile', 'omp.job.tile'])
    expect(JSON.stringify(tiles.c![0])).toContain('omp.job.tile.chart')
    expect(JSON.stringify(tiles.c![1])).toContain('omp.job.tile.lead')
  })
})

describe('the author prompt', () => {
  it('samples distinct lines and carries the rejected answer', () => {
    const tail = Array.from({ length: 10 }, (_, i) => `step ${i} loss=${i}`)
    const [s] = promptSources([{ head: ['starting', '```'], id: 'out', label: 'train', lines: 12, size: 200, tail }])

    // Three lines of one shape at most; fences left out.
    expect(s!.head).toEqual(['starting'])
    expect(s!.tail).toEqual(['step 7 loss=7', 'step 8 loss=8', 'step 9 loss=9'])

    const prompt = renderPrompt({
      command: 'python train.py',
      id: 'proc_1',
      rejected: { answer: '{}', errors: ['title: required'] },
      sources: [{ head: ['a'], id: 'out', label: 'train', lines: 1, size: 2, tail: [] }]
    })

    expect(prompt).toContain('python train.py')
    expect(prompt).toContain('- title: required')
    expect(SYSTEM_PROMPT).toContain('"match":"^req \\\\d+ rps=(?P<rps>[\\\\d.]+)')
  })
})

describe('process calls show their process', () => {
  const call = (name: string, args: Record<string, unknown>, result?: unknown): ToolCall => ({
    args,
    argsText: '',
    context: '',
    id: toolCallId(`${name}-${JSON.stringify(args)}`),
    name,
    result,
    startedAt: 0,
    status: 'done'
  })

  it('links a wait, poll or log by its id prefix, as omp tiles the jobs a wait watches', () => {
    const procs = [proc({ id: 'proc_4dae56ca81f6' }), proc({ id: 'proc_9b00aa', command: 'sleep 9' })]
    const start = call('terminal', { background: true, command: 'bench --goal 60' }, { session_id: 'proc_4dae56ca81f6' })
    const wait = call('process', { action: 'wait', session_id: 'proc_4dae' })
    const poll = call('process', { action: 'poll', session_id: 'proc_4dae56ca81f6' })
    const vague = call('process', { action: 'wait', session_id: 'proc_' })

    expect([wait, poll, vague, call('process', { action: 'kill', session_id: 'proc_4dae' })].map(isWatchCall)).toEqual([true, true, true, false])
    const owners = linkCalls([start, wait, poll, vague], procs)
    expect(owners.get(start)?.id).toBe('proc_4dae56ca81f6')
    expect(owners.get(wait)?.id).toBe('proc_4dae56ca81f6')
    expect(owners.get(poll)?.id).toBe('proc_4dae56ca81f6')
    // A prefix two processes share names neither.
    expect(owners.has(vague)).toBe(false)
  })
})

describe('chart memory', () => {
  it('lets a later pane chart a process without asking the model again', async () => {
    const memory = chartMemory(join(mkdtempSync(join(tmpdir(), 'charts-')), 'charts'))
    let asked = 0
    const author = async () => (asked++, LOAD)
    const p = proc({ output: lines(5) })

    new Charts(() => undefined, { author, memory, now: () => 20_000 }).view(p)
    await new Promise(r => setTimeout(r, 0))
    expect(asked).toBe(1)

    const later = new Charts(() => undefined, { author, memory, now: () => 30_000 }).view(p)
    expect(later?.state).toBe('live')
    expect(asked).toBe(1)
  })

  it('remembers a decline, and ignores a file that is not a spec', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'charts-')), 'charts')
    const memory = chartMemory(dir)
    memory.save('proc_1', { skip: 3 })
    expect(memory.load('proc_1')).toEqual({ skip: 3 })
    memory.save('proc_2', { title: 'x' } as unknown as Spec)
    expect(memory.load('proc_2')).toBeUndefined()
    expect(memory.load('../etc/passwd')).toBeUndefined()
  })
})

describe('log files', () => {
  const env = { HOME: '/home/u', TMPDIR: '/var/tmp/' }

  it('finds where a command sends its output', () => {
    expect(outputFiles('pytest -x > /tmp/t.log 2>&1', env)).toEqual(['/tmp/t.log'])
    expect(outputFiles('make 2>&1 | tee -a ~/build.log', env)).toEqual(['/home/u/build.log'])
    expect(outputFiles('cd /repo && npm test &> out/run.txt', env)).toEqual(['/repo/out/run.txt'])
    expect(outputFiles('bench >> "$TMPDIR/b.log"', env)).toEqual(['/var/tmp/b.log'])
    // Errors alone, /dev/null, unknown variables and relative paths without a `cd` are not output files.
    expect(outputFiles('a 2> /tmp/err.log; b > /dev/null; c > $OUT/x.log; d > rel.log', env)).toEqual([])
  })

  it('reads a log as it grows, and again after it is rewritten', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'log-')), 'run.log')
    const tap = new FileTap('file:1', file)
    tap.update()
    expect(tap.read(0).text).toBe('')

    writeFileSync(file, 'step 1\n')
    tap.update()
    appendFileSync(file, 'step 2\n')
    tap.update()
    expect(tap.read(0)).toMatchObject({ start: 0, text: 'step 1\nstep 2\n' })

    writeFileSync(file, 'new\n')
    tap.update()
    const after = tap.read(14)
    expect(after.start).toBeGreaterThan(14)
    expect(after.text).toBe('new\n')
  })

  it('charts a process from the log its command writes to', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-'))
    const file = join(dir, 'bench.log')
    writeFileSync(file, lines(6))
    const seen: string[] = []
    const charts = new Charts(() => undefined, {
      author: async request => (seen.push(...request.sources.map(s => s.id)), { ...LOAD, rules: [{ ...LOAD.rules[0]!, from: 'file:1' }] }),
      now: () => 20_000
    })
    const p = proc({ command: `bench --goal 60 > ${file} 2>&1` })

    charts.view(p)
    await new Promise(r => setTimeout(r, 0))
    expect(seen).toEqual(['file:1'])
    appendFileSync(file, lines(2, 7))
    expect((charts.view(p)?.blocks[0] as SparkBlock).values).toHaveLength(8)
  })
})

describe('a declined chart', () => {
  it('is asked again once the output has doubled and grown by 5 lines', async () => {
    let asked = 0
    const charts = new Charts(() => undefined, { author: async () => (asked++ ? LOAD : { skip: 'only shell noise' }), now: () => 20_000 })
    const noise = "(anon):setopt:5: can't change option: monitor\n[ERROR]: gitstatus failed to initialize.\n"
    const p = proc({ output: `${noise}req 1 rps=51 p50=40ms\n` })

    charts.view(p)
    await new Promise(r => setTimeout(r, 0))
    expect(asked).toBe(1)

    p.output += lines(2, 2)
    charts.view(p)
    await new Promise(r => setTimeout(r, 0))
    expect(asked).toBe(1)

    p.output += lines(5, 4)
    charts.view(p)
    await new Promise(r => setTimeout(r, 0))
    expect(asked).toBe(2)
    expect(charts.view(p)?.state).toBe('live')
  })
})
