import type { GoalSnapshot, LoopSnapshot, SessionControlSnapshot } from '@hermes/shared/gateway-events'
import { plain } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { Automation, type AutomationHost, cadence, countdown, goalView, loopView } from '../automation.js'
import { automationButtons } from '../overlays/automation.js'
import { automationNode, reconnectNode } from '../view/automation.js'

import { stub } from './fakes.js'

const goal = (over: Partial<GoalSnapshot> = {}): GoalSnapshot => ({
  contract: {},
  gates: [],
  max_turns: 20,
  status: 'active',
  subgoals: [],
  title: 'Ship the parser',
  turns_used: 3,
  ...over
})

const NOW = 1_700_000_000_000

const loop = (over: Partial<LoopSnapshot> = {}): LoopSnapshot => ({
  awaiting_response: false,
  created_at: 0,
  current_delay: 0,
  deferred_by_goal: false,
  interval_seconds: 2700,
  last_fired_at: 0,
  max_ticks: 0,
  mode: 'interval',
  next_due_at: NOW / 1000 + 240,
  prompt: 'check the deploy',
  status: 'active',
  ticks_fired: 2,
  times: 0,
  until: '',
  ...over
})

const snapshot = (over: Partial<SessionControlSnapshot> = {}): SessionControlSnapshot => ({
  goal: null,
  heartbeat: null,
  loop: null,
  revision: 'r1',
  updated_at: 1,
  ...over
})

const text = (node: unknown) => plain(stub({ main: [node] }), 200)

describe('goalView', () => {
  it('shows a standing goal, held or judged blocked, and nothing once it is done', () => {
    expect(goalView(goal())).toMatchObject({ maxTurns: 20, state: 'active', title: 'Ship the parser', turns: 3 })
    expect(goalView(goal({ paused_reason: 'budget', status: 'paused' }))).toMatchObject({ detail: 'budget', state: 'paused' })
    expect(goalView(goal({ last_reason: 'tests fail', last_verdict: 'blocked' }))).toMatchObject({
      reason: 'tests fail',
      state: 'blocked',
      verdict: 'blocked'
    })
    expect(goalView(goal({ wait_barrier: { reason: 'CI', target: 'abc', type: 'session' } }))).toMatchObject({
      detail: 'on session abc · CI',
      state: 'waiting'
    })
    expect(goalView(goal({ status: 'done' }))).toBeNull()
    expect(goalView(null)).toBeNull()
  })
})

describe('loopView', () => {
  it('counts down to next_due_at, then says it is due', () => {
    expect(loopView(loop(), NOW)).toMatchObject({ cadence: 'every 45m', dueAt: NOW + 240_000, runs: '2 runs', state: 'active' })
    expect(loopView(loop(), NOW + 300_000)).toMatchObject({ dueAt: undefined, state: 'due' })
  })

  it('reads paused, running and deferred loops, and drops a stopped one', () => {
    expect(loopView(loop({ paused_reason: 'by you', status: 'paused' }), NOW)).toMatchObject({ detail: 'by you', state: 'paused' })
    expect(loopView(loop({ awaiting_response: true }), NOW)).toMatchObject({ state: 'running' })
    expect(loopView(loop({ deferred_by_goal: true }), NOW)).toMatchObject({ state: 'deferred' })
    expect(loopView(loop({ times: 5 }), NOW)?.runs).toBe('2/5 runs')
    expect(loopView(loop({ status: 'done' }), NOW)).toBeNull()
  })

  it('writes cadences and countdowns as Ink does', () => {
    expect(cadence({ interval_seconds: 7200, mode: 'interval' })).toBe('every 2h')
    expect(cadence({ interval_seconds: 45, mode: 'interval' })).toBe('every 45s')
    expect(cadence({ interval_seconds: 0, mode: 'self_paced' })).toBe('self-paced')
    expect(countdown(3900)).toBe('1h05m')
    expect(countdown(44)).toBe('44s')
  })
})

describe('the dock line', () => {
  const line = (g: GoalSnapshot | null, l: LoopSnapshot | null) =>
    automationNode({ goal: goalView(g), loop: loopView(l, NOW), loopOwner: l, onGoal: () => {}, onLoop: () => {} }, NOW)

  it('is not drawn when nothing stands', () => {
    expect(line(null, null)).toBeNull()
    expect(line(goal({ status: 'done' }), loop({ status: 'done' }))).toBeNull()
  })

  it('shows the goal with its turns and the loop with its cadence and countdown', () => {
    const out = text(line(goal(), loop()))

    expect(out).toContain('Goal')
    expect(out).toContain('Ship the parser')
    expect(out).toContain('3/20')
    expect(out).toContain('Loop')
    expect(out).toContain('check the deploy')
    expect(out).toContain('every 45m · next in')
  })

  it('says when either is paused', () => {
    const out = text(line(goal({ status: 'paused' }), loop({ status: 'paused' })))

    expect(out).toContain('Goal paused')
    expect(out).toContain('Loop paused')
  })

  it('counts the loop down from the age it was first sent with', () => {
    const l = loop()
    const first = automationNode({ goal: null, loop: loopView(l, NOW), loopOwner: l, onGoal: () => {}, onLoop: () => {} }, NOW)
    const later = automationNode({ goal: null, loop: loopView(l, NOW), loopOwner: l, onGoal: () => {}, onLoop: () => {} }, NOW + 5000)

    expect(JSON.stringify(first)).toContain('-240000')
    expect(JSON.stringify(later)).toContain('-240000')
  })
})

describe('the sheet buttons', () => {
  it('offers pause or resume first, the wait release while waiting, and clear or stop behind a question', () => {
    expect(automationButtons('goal', { state: 'active' }).map(b => b.action)).toEqual(['goal.pause', 'goal.clear'])
    expect(automationButtons('goal', { state: 'paused' }).map(b => b.action)).toEqual(['goal.resume', 'goal.clear'])
    expect(automationButtons('goal', { state: 'waiting' }).map(b => b.action)).toEqual(['goal.pause', 'goal.unwait', 'goal.clear'])
    expect(automationButtons('loop', { state: 'paused' }).map(b => b.action)).toEqual(['loop.resume', 'loop.stop'])
    expect(automationButtons('loop', { state: 'active' }).find(b => b.action === 'loop.stop')?.confirm).toBeTruthy()
  })
})

describe('Automation', () => {
  const host = (answers: Record<string, (params: Record<string, unknown>) => unknown>) => {
    const calls: [string, Record<string, unknown>][] = []
    const notices: string[] = []
    const dispatched: unknown[] = []
    const request = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      calls.push([method, params])

      return answers[method]?.(params)
    }
    const h: AutomationHost = {
      changed: vi.fn(),
      gw: stub({ request }),
      runDispatch: async (raw: unknown) => void dispatched.push(raw),
      sid: 's1',
      transcript: { notice: (t: string) => void notices.push(t) }
    }

    return { automation: new Automation(h), calls, dispatched, h, notices }
  }

  it('seeds from session.control.read and follows session.control.update for its session only', async () => {
    const { automation, calls } = host({ 'session.control.read': () => ({ control: snapshot({ goal: goal() }) }) })

    automation.adopt('s1')
    await vi.waitFor(() => expect(automation.goal?.title).toBe('Ship the parser'))
    expect(calls).toEqual([['session.control.read', { session_id: 's1' }]])

    automation.apply('s1', snapshot({ loop: loop({ next_due_at: Date.now() / 1000 + 60 }) }))
    expect(automation.goal).toBeNull()
    expect(automation.loop()?.state).toBe('active')

    automation.apply('other', snapshot({ goal: goal() }))
    expect(automation.goal).toBeNull()
  })

  it('never lets a slow read overwrite a newer update', async () => {
    let answer: (v: unknown) => void = () => {}
    const { automation } = host({ 'session.control.read': () => new Promise(resolve => (answer = resolve)) })

    automation.adopt('s1')
    automation.apply('s1', snapshot({ goal: goal({ title: 'newer' }) }))
    answer({ control: snapshot({ goal: goal({ title: 'older' }) }) })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(automation.goal?.title).toBe('newer')
  })

  it('forgets the last session on adopt', async () => {
    const { automation } = host({ 'session.control.read': () => ({ control: snapshot() }) })

    automation.adopt('s1')
    automation.apply('s1', snapshot({ goal: goal() }))
    automation.adopt('s2')
    expect(automation.goal).toBeNull()
  })

  it('sends a verb, repaints from its reply and runs a goal resume kickoff as a typed /goal resume', async () => {
    const reply = {
      control: snapshot({ goal: goal() }),
      dispatch: { display: '/goal resume', message: 'Continue toward the goal', notice: null, output: null, type: 'send' }
    }
    const { automation, calls, dispatched } = host({
      'session.control': () => reply,
      'session.control.read': () => ({ control: snapshot({ goal: goal({ status: 'paused' }) }) })
    })

    automation.adopt('s1')
    await vi.waitFor(() => expect(automation.goal?.state).toBe('paused'))
    await automation.act('goal.resume')

    expect(calls.at(-1)).toEqual(['session.control', { action: 'goal.resume', session_id: 's1' }])
    expect(automation.goal?.state).toBe('active')
    expect(dispatched).toEqual([reply.dispatch])
    expect(automation.pending).toBeUndefined()
  })

  it('says when a verb fails', async () => {
    const { automation, notices } = host({
      'session.control': () => {
        throw new Error('permission_denied')
      },
      'session.control.read': () => ({ control: snapshot() })
    })

    automation.adopt('s1')
    await automation.act('loop.stop')

    expect(notices).toEqual(['Could not stop the loop: permission_denied'])
  })
})

describe('the reconnect line', () => {
  it('shows the try and a countdown to the next, then that it is trying', () => {
    const r = { attempt: 3, dueAt: NOW + 4000 }

    expect(text(reconnectNode(r, NOW))).toContain('Reconnecting to Hermes · attempt 3 · next try in')
    expect(JSON.stringify(reconnectNode(r, NOW))).toContain('-4000')
    expect(text(reconnectNode({ attempt: 4, dueAt: NOW }, NOW + 1))).toContain('attempt 4 · trying now…')
    expect(reconnectNode(undefined, NOW)).toBeNull()
  })
})
