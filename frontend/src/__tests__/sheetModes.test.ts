import { describe, expect, it } from 'vitest'

import { HUB_CLICKS, type HubAction, hubKey, type HubState, initialHub, reduceHub } from '../agents/hub.js'
import type { BackgroundProcess, Subagent } from '../model.js'
import type { CronJob } from '../processes/cron.js'
import { initialSheet, reduceSheet, SHEET_CLICKS, type SheetFacts, sheetKey, type SheetState } from '../processes/sheet.js'

import { key } from './fakes.js'

function agent(id: string, status: Subagent['status'], steps = 0): Subagent {
  return {
    calls: 0,
    goal: `goal of ${id}`,
    id,
    index: 0,
    log: { entries: Array.from({ length: steps }, (_, i) => ({ at: '10:00:00', kind: 'note' as const, text: `step ${i}` })) },
    startedAt: 0,
    status,
    tokens: 0,
    toolCount: 0
  }
}

const AGENTS = [agent('a1', 'running', 3), agent('a2', 'done'), agent('a3', 'running')]

/** Runs `action` from `state`, returning the next state and the effect's kind. */
const hub = (state: HubState, action: HubAction | undefined) => {
  if (!action) {
    return { effect: undefined, state }
  }

  const step = reduceHub(state, action, AGENTS)

  return { effect: step.effect?.kind, state: step.state }
}

describe('the agents hub reducer', () => {
  const start = initialHub(AGENTS)

  it('opens on Running and the first running agent', () => {
    expect(start).toEqual({ ask: { kind: 'none' }, selected: 'a1', tab: 'running', view: { kind: 'list' } })
    expect(initialHub([agent('a2', 'done')]).tab).toBe('all')
  })

  it('gives a key and its button the same action and the same state', () => {
    const pairs: [string, keyof typeof HUB_CLICKS, HubState][] = [
      ['escape', 'close', start],
      ['s', 'steer', start],
      ['x', 'stop', start],
      ['t', 'watch', start],
      ['p', 'pause', start],
      ['enter', 'beside', start],
      ['escape', 'steer-cancel', { ...start, ask: { kind: 'steering', text: 'hi' } }],
      ['enter', 'steer-send', { ...start, ask: { kind: 'steering', text: 'hi' } }],
      ['escape', 'cancel', { ...start, ask: { kind: 'confirmStop' } }],
      ['enter', 'confirm', { ...start, ask: { kind: 'confirmStop' } }]
    ]

    for (const [name, id, state] of pairs) {
      const byKey = hubKey(state, key(name), AGENTS)
      const byClick = HUB_CLICKS[id]({})

      expect(byKey, `${name} / ${id}`).toEqual(byClick)
      expect(hub(state, byKey)).toEqual(hub(state, byClick))
    }

    expect(hubKey(start, key('tab'), AGENTS)).toEqual(HUB_CLICKS.tab({ value: 'all' }))
  })

  it('steers and stops only a running agent, one question at a time', () => {
    const done = { ...start, selected: 'a2' }

    expect(hub(done, { type: 'steer' }).state).toBe(done)
    expect(hub(done, { type: 'stop' }).state).toBe(done)

    const steering = hub(start, { type: 'steer' }).state

    expect(steering.ask).toEqual({ kind: 'steering', text: '' })
    // Typing edits the message; the keys that would move or stop are text now.
    expect(hubKey(steering, key('x', { text: 'x' }), AGENTS)).toEqual({ text: 'x', type: 'steerEdit' })
    expect(hub(steering, { type: 'stop' }).state.ask).toEqual({ kind: 'confirmStop' })
  })

  it('sends the trimmed message, and nothing when it is blank', () => {
    const sent = reduceHub({ ...start, ask: { kind: 'steering', text: '  go left ' } }, { type: 'steerSend' }, AGENTS)

    expect(sent.state.ask).toEqual({ kind: 'none' })
    expect(sent.effect).toEqual({ agent: AGENTS[0], kind: 'steer', text: 'go left' })
    expect(hub({ ...start, ask: { kind: 'steering', text: '  ' } }, { type: 'steerSend' })).toEqual({ effect: undefined, state: start })
  })

  it('opens a timeline that follows the newest step, and Esc goes back to its agent', () => {
    const { effect, state } = hub({ ...start, selected: 'a1' }, { type: 'watch' })

    expect(effect).toBe('refresh')
    expect(state.view).toEqual({ agent: 'a1', kind: 'timeline', step: undefined })
    expect(hubKey(state, key('up'), AGENTS)).toEqual({ id: 'e1', type: 'step' })

    const older = hub(state, { id: 'e1', type: 'step' }).state

    expect(older.view).toEqual({ agent: 'a1', kind: 'timeline', step: 'e1' })
    // Back on the newest step: it follows again.
    expect(hub(older, { id: 'e2', type: 'step' }).state.view).toEqual({ agent: 'a1', kind: 'timeline', step: undefined })
    expect(hub({ ...older, selected: 'a3' }, { type: 'back' }).state).toEqual({ ...start, selected: 'a1' })
  })

  it('picks the first listed agent when the tab hides the picked one', () => {
    expect(hub({ ...start, selected: 'a2' }, { ids: ['a1', 'a3'], type: 'listed' }).state.selected).toBe('a1')
    expect(hub(start, { ids: ['a1', 'a3'], type: 'listed' }).state).toBe(start)
  })

  it('a row pick ends the stop question', () => {
    expect(hub({ ...start, ask: { kind: 'confirmStop' } }, { id: 'a3', type: 'select' }).state).toEqual({ ...start, selected: 'a3' })
  })
})

function process(id: string, status: 'done' | 'running'): BackgroundProcess {
  return { command: `run ${id}`, id, lastLine: '', output: '', startedAt: 0, state: { status } }
}

const JOBS: CronJob[] = [{ job_id: 'j1', name: 'nightly' }, { enabled: false, job_id: 'j2' }]

const FACTS: SheetFacts = {
  busy: id => id === 'busy',
  jobs: JOBS,
  processes: [process('p1', 'running'), process('p2', 'done')],
  stopping: () => false
}

const sheet = (state: SheetState, action: Parameters<typeof reduceSheet>[1] | undefined) => {
  if (!action) {
    return { effect: undefined, state }
  }

  const step = reduceSheet(state, action, FACTS)

  return { effect: step.effect?.kind, state: step.state }
}

describe('the Background sheet reducer', () => {
  const start = initialSheet(FACTS.processes)
  const cron = { ...initialSheet(FACTS.processes, { tab: 'cron' }), job: 'j1' }

  it('opens on the focused process\'s tab, or on Cron', () => {
    expect(start).toMatchObject({ selected: 'p1', tab: 'running' })
    expect(initialSheet(FACTS.processes, 'p2')).toMatchObject({ selected: 'p2', tab: 'all' })
    expect(initialSheet(FACTS.processes, { tab: 'cron' }).tab).toBe('cron')
  })

  it('gives a key and its button the same action and the same state', () => {
    const asking = { ...start, confirm: 'one' as const }
    const pairs: [string, { shift?: boolean }, keyof typeof SHEET_CLICKS, SheetState][] = [
      ['escape', {}, 'close', start],
      ['escape', {}, 'close', { ...start, expanded: true }],
      ['enter', {}, 'expand', start],
      ['k', {}, 'stop', start],
      ['k', { shift: true }, 'all', start],
      ['c', {}, 'copy', start],
      ['escape', {}, 'cancel', asking],
      ['enter', {}, 'confirm', asking],
      ['p', {}, 'toggle', cron],
      ['d', {}, 'remove', cron]
    ]

    for (const [name, mods, id, state] of pairs) {
      const byKey = sheetKey(state, key(name, mods), FACTS)
      const byClick = SHEET_CLICKS[id]({})

      expect(byKey, `${name} / ${id}`).toEqual(byClick)
      expect(sheet(state, byKey)).toEqual(sheet(state, byClick))
    }

    expect(sheetKey(start, key('tab'), FACTS)).toEqual(SHEET_CLICKS.tab({ value: 'all' }))
    expect(sheetKey(start, key('tab', { shift: true }), FACTS)).toEqual(SHEET_CLICKS.tab({ value: 'cron' }))
  })

  it('asks before it stops, and only for a process that runs', () => {
    expect(sheet(start, { type: 'ask', what: 'one' }).state.confirm).toBe('one')
    expect(sheet({ ...start, selected: 'p2' }, { type: 'ask', what: 'one' }).state.confirm).toBeUndefined()
    expect(sheet({ ...start, confirm: 'one' }, { type: 'confirm' })).toEqual({ effect: 'stopOne', state: start })
    expect(sheet({ ...start, confirm: 'all' }, { type: 'confirm' })).toEqual({ effect: 'stopAll', state: start })
  })

  it('pauses a job unless an action on it is in flight, and removes it after the question', () => {
    expect(reduceSheet(cron, { type: 'toggleJob' }, FACTS).effect).toEqual({ action: 'pause', job: JOBS[0], kind: 'job' })
    expect(reduceSheet({ ...cron, job: 'j2' }, { type: 'toggleJob' }, FACTS).effect).toEqual({ action: 'resume', job: JOBS[1], kind: 'job' })
    expect(reduceSheet({ ...cron, confirm: 'job' }, { type: 'confirm' }, FACTS).effect).toEqual({ action: 'remove', job: JOBS[0], kind: 'job' })
  })

  it('a tab leaves the output and the question behind', () => {
    expect(sheet({ ...start, confirm: 'one', expanded: true }, { tab: 'all', type: 'tab' }).state).toEqual({ ...start, tab: 'all' })
    // While the output has the sheet, Tab is not a tab switch.
    expect(sheetKey({ ...start, expanded: true }, key('tab'), FACTS)).toBeUndefined()
  })

  it('marks the copied command until its time is up', () => {
    const copied = reduceSheet(start, { type: 'copy' }, FACTS)

    expect(copied.effect).toEqual({ command: 'run p1', kind: 'copy' })
    expect(copied.state.copied).toBe('p1')
    expect(sheet(copied.state, { type: 'uncopy' }).state).toEqual(start)
  })
})
