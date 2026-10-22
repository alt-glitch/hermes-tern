// Background work as the transcript and the dock tell it (a live session, 2026-10-22): a subagent's
// end is a line in the transcript when it happens, the dock says what an idle session waits for,
// a background process's exit is a line too, the working row's timer is the step's as well as the
// turn's, a chart that is not drawn says why, and a queued row that cannot steer says why.
import type { GatewayClient } from '@tui/gatewayClient.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { liveSessionId } from '../core/ids.js'
import type { BackgroundProcess, Block, Entry } from '../model.js'
import { Processes } from '../processes/store.js'
import { Charts } from '../processes/widgets/registry.js'
import { Transcript } from '../transcript/store.js'
import { Activity } from '../turn/activity.js'
import { dockActivity } from '../view/dockModel.js'
import { foldOf } from '../view/workLogModel.js'
import type { ProcessRow } from '../wire/schemas.js'

import { type App, busy, settle, setup } from './appSetup.js'
import { given, key, stub } from './fakes.js'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))

beforeEach(() => {
  delete process.env['HERMES_TUI_QUERY']
  delete process.env['HERMES_TUI_IMAGE']
})

afterEach(() => {
  vi.useRealTimers()
})

const NOW = 1_800_000_000_000
const ev = (type: string, payload: Record<string, unknown> = {}) => ({ payload, session_id: 's1', type })

/** The background lines of the transcript: in the live turn, and between turns. */
function lines(entries: readonly Entry[]): string[] {
  return entries.flatMap(e =>
    e.kind === 'turn' ? e.blocks.flatMap((b: Block) => (b.kind === 'event' ? [b.text] : [])) : e.kind === 'notice' && e.tone !== 'warning' ? [e.text] : []
  )
}

/** A background delegation of `goals`, dispatched in the live turn. */
function dispatch(emit: (name: string, arg: unknown) => void, goals: string[]) {
  emit('event', ev('message.start'))
  emit('event', ev('tool.start', { args: { tasks: goals.map(goal => ({ goal })) }, name: 'delegate_task', tool_id: 'd1' }))
  emit(
    'event',
    ev('tool.complete', {
      name: 'delegate_task',
      result: { delegation_id: 'deleg_1', mode: 'background', status: 'dispatched' },
      tool_id: 'd1'
    })
  )
}

const agentEvent = (type: string, index: number, goal: string, over: Record<string, unknown> = {}) =>
  ev(type, { delegation_id: 'deleg_1', goal, subagent_id: `sa${index}`, task_count: 2, task_index: index, ...over })

describe('a subagent that ends is a line in the transcript, when it ends', () => {
  it('in the turn that still runs, and between turns once the turn ended', async () => {
    const { app, emit, tern } = setup()
    dispatch(emit, ['Read-only survey of the desktop gates', 'Check the docs'])
    emit('event', agentEvent('subagent.start', 0, 'Read-only survey of the desktop gates'))
    emit('event', agentEvent('subagent.start', 1, 'Check the docs'))
    emit('event', agentEvent('subagent.complete', 0, 'Read-only survey of the desktop gates', { duration_seconds: 273, status: 'completed' }))
    await settle()

    const turn = app.transcript.live
    expect(lines(app.transcript.entries)).toEqual(['Agent "Read-only survey of the desktop gates" finished · 4m 33s'])
    expect(turn?.blocks.at(-1)?.kind).toBe('event')
    expect(JSON.stringify(tern.frame)).toContain('"role":"hermes.event"')

    emit('event', ev('message.complete', { text: 'Working on it.' }))
    emit('event', agentEvent('subagent.complete', 1, 'Check the docs', { duration_seconds: 9, status: 'failed' }))
    await settle()

    expect(lines(app.transcript.entries)).toEqual([
      'Agent "Read-only survey of the desktop gates" finished · 4m 33s',
      'Agent "Check the docs" failed · 9s'
    ])
    expect(app.transcript.entries.at(-1)).toMatchObject({ kind: 'notice', tone: 'error' })
  })

  it('says nothing for an agent this pane never saw run (a resumed history)', async () => {
    const { app, emit } = setup()
    emit('event', ev('message.start'))
    emit('event', ev('tool.start', { args: { goal: 'Old work' }, name: 'delegate_task', tool_id: 'd1' }))
    emit('event', agentEvent('subagent.complete', 0, 'Old work', { duration_seconds: 3, status: 'completed' }))
    await settle()

    expect(lines(app.transcript.entries)).toEqual([])
  })

  it('the multi-agent card says how many background agents it launched', async () => {
    const { app, emit } = setup()
    dispatch(emit, ['One', 'Two', 'Three'])
    await settle()

    expect(JSON.stringify(app.transcript.entries)).toContain('delegate_task')
    const { taskViewHead } = await import('../view/tools/cards/task.js')
    const call = app.transcript.lastCall(c => c.name === 'delegate_task')
    expect(call && taskViewHead(call)).toEqual({ target: '3 background agents', title: 'Launched' })
  })
})

describe("a finished turn's fold", () => {
  it('keeps the lines of background work in view', () => {
    const t = new Transcript()
    const turn = t.messageStart(NOW)
    t.toolStart({ name: 'terminal', tool_id: 'c1' }, NOW + 1)
    t.toolComplete({ name: 'terminal', tool_id: 'c1' }, NOW + 2)
    t.event('Agent "x" finished · 3s', 'success', NOW + 3)
    t.text('Done.', NOW + 4)
    t.complete({ text: 'Done.' }, NOW + 5)

    const event = turn.blocks.find(b => b.kind === 'event')
    expect(event).toBeDefined()
    expect(foldOf(turn)?.hidden.has(event?.id ?? '')).toBe(false)
  })
})

describe('the dock while an idle session waits on its background agents', () => {
  it('says how many it waits for, and since when', () => {
    const agent = { startedAt: NOW - 90_000 }
    const running = [agent, { startedAt: NOW - 30_000 }]

    expect(dockActivity({ busy: null, compacting: undefined }, running)).toEqual({ count: 2, kind: 'agents', since: agent, startedAt: NOW - 90_000 })
    expect(dockActivity({ busy: { ...busy }, compacting: undefined }, running).kind).toBe('turn')
    expect(dockActivity({ busy: null, compacting: undefined }, []).kind).toBe('idle')
  })

  it('draws "Waiting for 2 background agents" and opens the agents on a click', async () => {
    const { app, dockText, emit, tern } = setup()
    dispatch(emit, ['One', 'Two'])
    emit('event', agentEvent('subagent.start', 0, 'One'))
    emit('event', agentEvent('subagent.start', 1, 'Two'))
    emit('event', ev('message.complete', { text: 'Started them.' }))
    await settle()

    expect(app.busy).toBeNull()
    expect(dockText()).toContain('Waiting for 2 background agents')
    expect(JSON.stringify(tern.frame)).toContain('"role":"hermes.waiting.agents"')
  })
})

describe('the working row: the step it names has an age of its own', () => {
  it('a relabel starts a new step and keeps the turn its age', () => {
    const activity = new Activity()
    activity.startBusy('Working…', NOW)
    activity.relabel('Preparing terminal…', { now: NOW + 1_026_000 })

    expect(activity.busy).toMatchObject({ label: 'Preparing terminal…', startedAt: NOW, step: { at: NOW + 1_026_000 } })
    const step = activity.busy?.step
    activity.relabel('Preparing terminal…', { now: NOW + 1_030_000 })
    expect(activity.busy?.step).toBe(step)

    const a = dockActivity(activity, [])
    expect(a).toMatchObject({ kind: 'turn', step: { startedAt: NOW + 1_026_000 } })
  })
})

describe('a background process that exits is a line in the transcript', () => {
  it('names the command, how it ended and how long it ran; once', async () => {
    vi.useFakeTimers({ now: NOW })
    const transcript = new Transcript()
    transcript.messageStart(NOW)
    let rows: ProcessRow[] = [
      { command: 'bash /tmp/onb-repro/keep-dump.sh > /tmp/onb-repro/keep-dump.log 2>&1', session_id: 'proc_a', started_epoch: (NOW - 690_000) / 1000, status: 'running' }
    ]
    const request = vi.fn(async () => ({ processes: rows }))
    const ended: string[] = []
    const store = new Processes({
      changed: vi.fn(),
      gw: stub<Pick<GatewayClient, 'request'>>({ request }),
      processEnded: (p: BackgroundProcess) => ended.push(p.id),
      sid: liveSessionId('s1'),
      transcript
    })

    store.poke()
    await vi.advanceTimersByTimeAsync(0)
    expect(ended).toEqual([])

    rows = [{ ...(rows[0] ?? { session_id: 'x' }), exit_code: 0, exited_at: NOW / 1000, status: 'exited' }]
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(ended).toEqual(['proc_a'])
    const { processExitedLine } = await import('../view/backgroundLines.js')
    expect(processExitedLine(store.get('proc_a') ?? stub({}))).toEqual({ text: 'Background task keep-dump.sh exited (0) · 11m 30s', tone: 'success' })
    store.dispose()
  })

  it('says nothing for a process that had already ended when the pane first saw it', async () => {
    vi.useFakeTimers({ now: NOW })
    const rows: ProcessRow[] = [{ command: 'make', exit_code: 2, exited_at: NOW / 1000, session_id: 'proc_b', status: 'exited' }]
    const ended: string[] = []
    const store = new Processes({
      changed: vi.fn(),
      gw: stub<Pick<GatewayClient, 'request'>>({ request: async () => ({ processes: rows }) }),
      processEnded: (p: BackgroundProcess) => ended.push(p.id),
      sid: liveSessionId('s1'),
      transcript: new Transcript()
    })

    store.poke()
    await vi.advanceTimersByTimeAsync(0)
    expect(ended).toEqual([])
    store.dispose()
  })
})

describe('a chart that is not drawn says why', () => {
  const proc = (over: Partial<BackgroundProcess> = {}): BackgroundProcess => ({
    command: 'npm run dev > /tmp/dev.log 2>&1',
    id: 'proc_dev',
    lastLine: '',
    output: Array.from({ length: 12 }, (_, i) => `[vite] page reload src/app${i}.tsx`).join('\n') + '\n',
    startedAt: NOW - 20_000,
    state: { status: 'running' },
    ...over
  })

  const charts = (author: (r: unknown) => Promise<unknown>) => new Charts(() => undefined, { author, now: () => NOW })

  it('the model declined: its reason', async () => {
    const c = charts(async () => ({ skip: 'a dev server log has no quantity' }))
    const p = proc()
    c.view(p)
    await vi.waitFor(() => expect(c.view(p)?.note).toBe('Nothing to chart: a dev server log has no quantity.'))
  })

  it('no auxiliary model', async () => {
    const c = charts(async () => undefined)
    const p = proc()
    c.view(p)
    await vi.waitFor(() => expect(c.view(p)?.note).toContain('auxiliary.tern_charts'))
  })

  it('the chart model failed: its error', async () => {
    const c = charts(async () => {
      throw new Error('HTTP 429: rate limited')
    })
    const p = proc()
    c.view(p)
    await vi.waitFor(() => expect(c.view(p)?.note).toBe('The chart model failed: HTTP 429: rate limited. No more tries for this process.'))
  })

  it('not asked yet: what it waits for', () => {
    const c = charts(async () => ({ skip: 'x' }))

    expect(c.view(proc({ startedAt: NOW - 2000 }))?.note).toBe('A chart is written once the process has run 15s with output.')
  })

  it('no model to ask (the launcher named no Hermes Python)', () => {
    const c = new Charts(() => undefined, { now: () => NOW })

    expect(c.view(proc())?.note).toContain('no chart model')
  })
})

describe('a queued row that cannot steer says why', () => {
  const session = (mode: string) => ({
    'config.get': (p: Record<string, unknown>) => (p['key'] === 'busy' ? { key: 'busy', value: mode } : {}),
    'prompt.submit': () => ({ admission_id: 'a1', status: 'queued' }),
    'session.resume': () => ({ execution_generation: 7 })
  })

  it('a prompt with images waits for the turn: the row and a line say so (busy mode interrupt)', async () => {
    const { app, attach, press, queuedRows, sent, type } = setup(session('interrupt'))
    app.stores.session.busyMode = 'interrupt'
    given.busy(app.stores, { ...busy })
    await attach()
    await type('https://www.figma.com/design/x')
    await press(key('enter'))
    await settle()

    expect(sent('session.redirect')).toEqual([])
    expect(queuedRows()).toEqual([{ actions: ['edit'], note: 'has images: waits for this turn', text: 'https://www.figma.com/design/x ↵ 📎 1 image' }])
    expect(app.transcript.entries.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('Images cannot join a running turn') })
  })

  it("Hermes' own row (subagents finished) starts when the turn ends", async () => {
    const { app, emit, queuedRows } = setup()
    given.busy(app.stores, { ...busy })
    const row = { admission_id: 'auto1', status: 'queued', user: '[ASYNC DELEGATION BATCH COMPLETE — deleg_1]\nA background…' }
    emit('event', ev('session.info', { pending_submissions: [row] }))
    await settle()

    expect(queuedRows()).toEqual([{ actions: [], note: 'starts when this turn ends', text: 'Subagents finished' }])
  })
})

export type { App }
