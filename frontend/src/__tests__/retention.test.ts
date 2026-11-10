import { type Op, type Surface, type TspEvent } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { entryId, subagentKey, toolCallId } from '../core/ids.js'
import { transcriptContext, type FrameCx } from '../app/frame.js'
import type { Entry, TurnEntry } from '../model.js'
import { Transcript } from '../transcript/store.js'
import { RETAIN_TURNS, retentionBoundary, safeToSettle } from '../view/retention-policy.js'
import { RELOAD_PAGE, Retention, type RetentionLive } from '../view/retention.js'
import type { TranscriptContext } from '../view/transcript.js'

import { stub } from './fakes.js'

const defaultCopy = vi.fn()
const context = (copy = defaultCopy): TranscriptContext => ({
  copy,
  now: 1_000,
  welcome: { version: 'v1' }
})

function history(turns: number): Entry[] {
  const rows: Entry[] = []

  for (let i = 0; i < turns; i++) {
    rows.push({ at: 1, id: entryId('u' + i), kind: 'user', text: 'Prompt ' + i })
    rows.push({
      blocks: [{ id: entryId('x' + i), kind: 'text', text: 'Answer ' + i }],
      end: { status: 'done', endedAt: 2 },
      id: entryId('t' + i),
      kind: 'turn',
      rev: 1,
      startedAt: 1
    })
  }

  return rows
}

function turnAt(entries: readonly Entry[], i: number): TurnEntry {
  const e = entries[i * 2 + 1]

  if (e?.kind !== 'turn') {
    throw new Error('Missing test turn')
  }

  return e
}

/** Records actual SDK operations, not a second fake retention implementation. */
function harness(live?: () => RetentionLive, dirty?: Set<Entry>) {
  let current: readonly Entry[] = []
  let lifetime = 0
  const changedEntries = dirty ?? new Set<Entry>()
  const frames: Op[][] = []
  const changed = vi.fn()
  let blocked = false
  const raw = {
    id: 'hermes',
    closed: false,
    get blocked() { return blocked },
    send: (ops: Op[]) => { frames.push(ops) },
    dispatch: () => undefined,
    acknowledge: () => undefined
  }
  const surface = stub<Surface>(raw)
  const retention = new Retention(surface, changed, live ?? (() => ({ entries: current, lifetime })))
  const ops = () => frames.flat()
  const paint = (entries: readonly Entry[], cx = context(), hold = false) => {
    current = entries
    retention.paint({ dock: [], layer: [] }, entries, cx, hold, changedEntries)
  }
  const gone = (ids: string[], sf = 'hermes') =>
    retention.gone(stub<TspEvent>({ ev: 'gone', ids, sf }))
  const click = (id: string) =>
    retention.dispatch(stub<TspEvent>({ act: 'click', ev: 'action', id, raw: {}, sf: 'hermes' }))
  const since = (start: number) => ops().slice(start)

  return {
    changed, click, frames, gone, ops, paint, retention,
    mark: (entry: Entry) => { changedEntries.add(entry) },
    replace: (entries: readonly Entry[]) => { current = entries; lifetime++ },
    setBlocked: (value: boolean) => { blocked = value }, since, surface
  }
}

describe('retained long-session transcript', () => {
  it('uses 20 completed turns, protecting running, failed, interrupted and warning state', () => {
    const entries = history(30)
    turnAt(entries, 0).end = { status: 'live' }
    turnAt(entries, 1).end = { status: 'error', error: 'Service unavailable' }
    turnAt(entries, 2).end = { status: 'interrupted', endedAt: 2 }
    turnAt(entries, 3).warning = 'Incomplete output'
    turnAt(entries, 4).blocks.push({
      call: {
        id: toolCallId('job'), name: 'terminal', args: {}, argsText: '', context: '',
        outcome: { kind: 'running' }, startedAt: 1, via: { kind: 'direct' }
      },
      id: toolCallId('job'),
      kind: 'tool'
    })
    const h = harness()
    h.paint(entries)
    const settled = new Set(h.ops().filter(op => op[0] === 'settle').map(op => op[1]))

    for (let i = 0; i < 5; i++) {
      expect(settled.has('main.u' + i)).toBe(false)
      expect(settled.has('main.t' + i)).toBe(false)
    }

    expect(settled.has('main.t5')).toBe(true)
    expect(settled.has('main.u5')).toBe(true)
    expect(settled.has('main.t10')).toBe(false)
    expect(settled.has('main.t29')).toBe(false)
    expect(retentionBoundary(entries)).toBe(20)
    expect(RETAIN_TURNS).toBe(20)
  })

  it('never settles unresolved subagents, errors, unfinished compactions or notices', () => {
    const t = turnAt(history(1), 0)
    t.blocks.push({
      call: {
        id: toolCallId('delegate'), name: 'delegate_task', args: {}, argsText: '', context: '',
        outcome: { kind: 'done', duration: 10 }, startedAt: 1, via: { kind: 'direct' },
        subagents: [{
          id: 'child', key: subagentKey('child'), goal: 'inspect', index: 0, name: 'Agent 1',
          status: 'failed', toolCount: 0, tokens: 0, calls: 0, startedAt: 1
        }]
      },
      id: toolCallId('delegate'),
      kind: 'tool'
    })
    expect(safeToSettle(t)).toBe(false)
    expect(safeToSettle({ id: entryId('warning'), kind: 'notice', text: 'Review', tone: 'warning' })).toBe(false)
    expect(safeToSettle({ id: entryId('error'), kind: 'notice', text: 'Failed', tone: 'error' })).toBe(false)
    expect(safeToSettle({
      id: entryId('compact'), kind: 'compaction', rev: 1,
      compaction: { startedAt: 1, state: { status: 'running' } }
    })).toBe(false)
    expect(safeToSettle({ id: entryId('panel'), kind: 'panel', title: 'Report', text: 'Details' })).toBe(true)
  })

  it('keeps old main roots untouched on streaming and updates the addressed live turn', () => {
    const entries = history(25)
    const h = harness()
    h.paint(entries)
    const start = h.ops().length
    const live = turnAt(entries, 24)
    live.end = { status: 'live' }

    for (let i = 0; i < 25; i++) {
      const text = live.blocks[0]

      if (text?.kind === 'text') {
        text.text += 'x'
      }

      live.rev++
      h.mark(live)
      h.paint(entries)
    }

    const updates = h.since(start)
    expect(updates.some(op => (op[0] === 'add' || op[0] === 'del') && op[1] === 'main')).toBe(false)
    expect(updates.some(op => op[0] === 'move' || op[0] === 'reveal')).toBe(false)
    expect(updates.some(op => op.length > 1 && (op[1] === 'main.t0' || op[1] === 'main.u0'))).toBe(false)
    expect(updates.some(op => op[0] === 'text' || op[0] === 'set')).toBe(true)
  })

  it('does not resurrect evicted settled history until load is explicitly clicked', async () => {
    const entries = history(25)
    const h = harness()
    h.paint(entries)
    h.gone(['main.u1', 'main.t0', 'main.u0', 'main.t1'])
    h.paint(entries)
    const start = h.ops().length
    h.paint(entries)
    expect(h.since(start)).toEqual([])
    const before = h.ops().length
    expect(h.ops()).toContainEqual(expect.arrayContaining(['add', 'main.retention-load']))
    await h.click('main.retention-load')?.()
    h.paint(entries)
    const restored = h.since(before)
      .filter(op => op[0] === 'add' && /main\.[ut][01]$/.test(op[1]))
      .map(op => op[1])
    expect(restored).toEqual(['main.t1', 'main.u1', 'main.t0', 'main.u0'])
    expect(h.ops().some(op => op[0] === 'del' && op[1] === 'main.retention-load')).toBe(true)
  })

  it('refreshes present user clocks after credit recovery without reviving evicted history', () => {
    const entries = history(25)
    const first = entries[0]
    if (first?.kind !== 'user') throw new Error('expected user entry')
    first.at = Date.parse('2026-10-28T13:05:00Z')
    const h = harness()
    const oldClock = { ...context(), hour12: false }
    const newClock = { ...context(), hour12: true }
    h.paint(entries, oldClock)
    h.gone(['main.u0'])
    h.paint(entries, oldClock)
    const before = h.ops().length
    h.setBlocked(true)
    h.paint(entries, newClock)
    expect(h.since(before)).toEqual([])
    h.setBlocked(false)
    h.surface.acknowledge(1)
    expect(h.changed).toHaveBeenCalled()
    h.paint(entries, newClock)
    const refreshed = h.since(before)
    expect(refreshed).toContainEqual(['del', 'main.u1'])
    expect(refreshed.some(op => op[0] === 'add' && op[1] === 'main.u1')).toBe(true)
    expect(refreshed.some(op => op[0] === 'add' && op[1] === 'main.u0')).toBe(false)
    expect(refreshed.some(op => op[0] === 'del' && op[1] === 'main.t1')).toBe(false)
    h.retention.request()
    const reload = h.ops().length
    h.paint(entries, newClock)
    const added = h.since(reload).find(op => op[0] === 'add' && op[1] === 'main.u0')
    expect(added).toBeDefined()
    expect(JSON.stringify(added)).toContain(new Date(first.at).toLocaleTimeString([], { hour: '2-digit', hour12: true, minute: '2-digit' }))
  })

  it('reloads at most 40 evicted entries, reveals the oldest reloaded id, then releases the page', () => {
    const entries = history(60)
    const h = harness()
    h.paint(entries)
    const evicted = Array.from({ length: 40 }, (_, i) => ['main.u' + i, 'main.t' + i]).flat()
    h.gone(evicted)
    h.paint(entries)
    h.retention.request(true)
    const start = h.ops().length
    h.paint(entries)
    const added = h.since(start).filter(op => op[0] === 'add' && evicted.includes(op[1]))
    expect(added).toHaveLength(RELOAD_PAGE)
    expect(h.since(start)).toContainEqual(['reveal', 'main.u20', 'start'])
    expect(h.since(start).some(op => op[0] === 'settle' && op[1] === 'main.u20')).toBe(false)
    h.retention.request(true)
    const next = h.ops().length
    h.paint(entries)
    expect(h.since(next)).toContainEqual(['settle', 'main.u20'])
    expect(h.since(next).some(op => op[0] === 'add' && op[1] === 'main.u0')).toBe(true)
  })

  it('holds all cold settlement while a modal approval is visible', () => {
    const entries = history(30)
    const h = harness()
    h.paint(entries, context(), true)
    expect(h.ops().filter(op => op[0] === 'settle')).toHaveLength(0)
    const before = h.ops().length
    h.paint(entries, context(), false)
    expect(h.since(before)).toContainEqual(['settle', 'main.t0'])
    expect(h.since(before)).toContainEqual(['settle', 'main.u0'])
  })

  it('corrects a late settled turn once and waits for explicit reload if later evicted', () => {
    const entries = history(25)
    const h = harness()
    h.paint(entries)
    const turn = turnAt(entries, 0)
    const initial = h.ops().length
    const text = turn.blocks[0]

    if (text?.kind === 'text') {
      text.text += ' corrected'
    }

    turn.rev++
    h.mark(turn)
    h.paint(entries)
    expect(h.since(initial)).toContainEqual(['del', 'main.t0'])
    expect(h.since(initial)).toContainEqual(['settle', 'main.t0'])
    h.gone(['main.t0'])
    h.paint(entries)
    const evictedAt = h.ops().length
    turn.rev++
    h.mark(turn)
    h.paint(entries)
    expect(h.since(evictedAt).some(op => op[0] === 'add' && op[1] === 'main.t0')).toBe(false)
    h.retention.request()
    h.paint(entries)
    expect(h.since(evictedAt).some(op => op[0] === 'add' && op[1] === 'main.t0')).toBe(true)
  })

  it('repairs only a partial subtree eviction while a turn remains active', () => {
    const entries = history(25)
    const active = turnAt(entries, 24)
    active.end = { status: 'live' }
    const h = harness()
    h.paint(entries)
    const before = h.ops().length
    h.gone(['main.t24.x24'])
    h.paint(entries)
    expect(h.since(before).some(op => op[0] === 'add' && op[1] === 'main.t24.x24')).toBe(true)
    expect(h.since(before)).not.toContainEqual(['del', 'main.t24'])
  })

  it('ignores foreign evictions, removes old session IDs, and refuses a stale queued Copy', async () => {
    const entries = history(25)
    const copy = vi.fn()
    const h = harness()
    h.paint(entries, context(copy))
    h.gone(['main.t0'], 'another-surface')
    h.paint(entries, context(copy))
    expect(h.ops().some(op => op.length > 1 && op[1] === 'main.retention-load')).toBe(false)
    const action = h.click('main.u0.tools.copy')
    expect(action).toBeTypeOf('function')
    // The reducer replaced the live transcript, but paint has not run yet.
    h.replace([])
    await action?.()
    expect(copy).not.toHaveBeenCalled()
    h.paint([], context(copy))
    expect(h.ops()).toContainEqual(['del', 'main.u0'])
    expect(h.ops()).not.toContainEqual(['del', 'main.retention-load'])
  })

  it('defers all operations under credit pressure, then catches up on acknowledgement', () => {
    const h = harness()
    const entries = history(25)
    h.setBlocked(true)
    h.paint(entries)
    expect(h.frames).toHaveLength(0)
    entries.push({ at: 1, id: entryId('new-prompt'), kind: 'user', text: 'More' })
    h.paint(entries)
    h.setBlocked(false)
    h.surface.acknowledge(1)
    expect(h.changed).toHaveBeenCalled()
    h.paint(entries)
    expect(h.ops().some(op => op[0] === 'add' && op[1] === 'main.new-prompt')).toBe(true)
  })

  it('has a history-size-independent number of operations for one token', () => {
    const counts = [100, 1000].map(n => {
      const entries = history(n)
      const h = harness()
      h.paint(entries)
      const start = h.ops().length
      const last = turnAt(entries, n - 1)
      last.rev++
      h.mark(last)
      const tail = last.blocks[0]
      if (tail?.kind === 'text') { tail.text += ' token' }
      h.paint(entries)
      return h.since(start).length
    })
    expect(counts[0]).toBeGreaterThan(0)
    expect(counts[1]).toBe(counts[0])
  })

  it('rechecks the real Transcript lifetime before queued Copy on reset and load', async () => {
    const transcript = new Transcript()
    for (const entry of history(25)) {
      transcript.push(entry)
    }

    const copy = vi.fn()
    const cx = context(copy)
    const h = harness(() => ({ entries: transcript.entries, lifetime: transcript.lifetime }), transcript.changedEntries)
    h.paint(transcript.entries, cx)

    const staleReset = h.click('main.u0.tools.copy')
    expect(staleReset).toBeTypeOf('function')
    transcript.reset({ session: 'other', usage: undefined })
    // Deliberately execute before paint: the writer's old row map still exists.
    await staleReset?.()
    expect(copy).not.toHaveBeenCalled()

    h.paint(transcript.entries, cx)
    transcript.user({ at: 1, text: 'Current prompt' })
    h.paint(transcript.entries, cx)
    const current = transcript.entries.at(-1)
    if (current?.kind !== 'user') {
      throw new Error('Missing current user entry')
    }

    const currentAction = h.click(`main.${current.id}.tools.copy`)
    await currentAction?.()
    expect(copy).toHaveBeenCalledTimes(1)
    expect(copy).toHaveBeenCalledWith('Current prompt', current.id)

    const staleLoad = h.click(`main.${current.id}.tools.copy`)
    transcript.load([])
    await staleLoad?.()
    expect(copy).toHaveBeenCalledTimes(1)
    h.paint(transcript.entries, cx)
  })

  it('never executes a queued native action for evicted root or subtree IDs', async () => {
    const entries = history(25)
    const copy = vi.fn()
    const h = harness()
    h.paint(entries, context(copy))

    const oldRoot = h.click('main.u0.tools.copy')
    h.gone(['main.u0'])
    await oldRoot?.()
    expect(copy).not.toHaveBeenCalled()

    const oldChild = h.click('main.u1.tools.copy')
    h.gone(['main.u1.tools.copy'])
    await oldChild?.()
    expect(copy).not.toHaveBeenCalled()
    expect(h.click('main.u0.tools.copy')).toBeUndefined()
    expect(h.click('main.u1.tools.copy')).toBeUndefined()
  })

  it('signals a late edit to an old settled turn through the actual Transcript store', () => {
    const transcript = new Transcript()
    for (const entry of history(25)) {
      transcript.push(entry)
    }

    const h = harness(() => ({ entries: transcript.entries, lifetime: transcript.lifetime }), transcript.changedEntries)
    h.paint(transcript.entries)
    const old = turnAt(transcript.entries, 0)
    const call = {
      id: toolCallId('late'), name: 'terminal', args: {}, argsText: '', context: '',
      outcome: { kind: 'done' as const, duration: 1 }, startedAt: 1, via: { kind: 'direct' as const }
    }
    old.blocks.push({ call, id: call.id, kind: 'tool' })
    const before = h.ops().length
    transcript.touchCall(call)

    expect(transcript.changedEntries.has(old)).toBe(true)
    h.paint(transcript.entries)
    expect(h.since(before)).toContainEqual(['del', 'main.t0'])
    expect(h.since(before)).toContainEqual(['settle', 'main.t0'])
    expect(transcript.changedEntries.size).toBe(0)
  })

  it('refreshes a late backend version and logo without rebuilding evicted history', () => {
    const entries: Entry[] = [{ id: entryId('welcome'), kind: 'welcome' }, ...history(25)]
    const h = harness()
    const session = { info: { version: '1.0' }, ref: { live: null } }
    const frame = stub<Pick<FrameCx, 'session' | 'copies' | 'welcome'>>({
      session, copies: { copy: defaultCopy }, welcome: { version: '' }
    })
    h.paint(entries, transcriptContext(frame, 1_000))
    h.gone(['main.u0', 'main.t0'])
    h.paint(entries, transcriptContext(frame, 1_000))
    const before = h.ops().length

    // Session.info can arrive after welcome was first projected.
    session.info.version = '2.0'
    h.paint(entries, transcriptContext(frame, 1_001))
    const diff = h.since(before)
    expect(JSON.stringify(diff)).toContain('v2.0')
    const beforeLogo = h.ops().length
    frame.welcome.logo = 'uploaded-logo'
    h.paint(entries, transcriptContext(frame, 1_002))
    const logoDiff = h.since(beforeLogo)
    expect(JSON.stringify(logoDiff)).toContain('uploaded-logo')
    expect(logoDiff.some(op => op[0] === 'add' && (op[1] === 'main.u0' || op[1] === 'main.t0'))).toBe(false)
    expect(logoDiff.some(op => op[0] === 'del' && (op[1] === 'main.u0' || op[1] === 'main.t0'))).toBe(false)
    expect(diff.some(op => op[0] === 'add' && (op[1] === 'main.u0' || op[1] === 'main.t0'))).toBe(false)
    expect(diff.some(op => op[0] === 'del' && (op[1] === 'main.u0' || op[1] === 'main.t0'))).toBe(false)
  })

  it('inspects and builds constant steady work for 200 versus 2,000 entries', () => {
    const work = [200, 2000].map(size => {
      const entries = history(size / 2)
      const h = harness()
      h.paint(entries)
      const live = turnAt(entries, size / 2 - 1)
      live.end = { status: 'live' }
      live.rev++
      h.mark(live)
      h.paint(entries) // Boundary transition is not a steady token paint.

      let examined = 0
      let built = 0
      for (let i = 0; i < 128; i++) {
        const text = live.blocks[0]
        if (text?.kind === 'text') {
          text.text += 'x'
        }
        live.rev++
        h.mark(live)
        h.paint(entries)
        examined += h.retention.work.examined
        built += h.retention.work.nodeBuilds
      }

      return { examined, built }
    })

    expect(work[0]).toEqual({ examined: 128, built: 128 })
    expect(work[1]).toEqual(work[0])
  })
})
