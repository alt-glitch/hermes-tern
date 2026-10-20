// The dock's view model (dockModel), its bound actions (the index-taking ones), and a frame's order
// of side effects (drawFrame).
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type JSX, Node } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { drawFrame, type FrameCx } from '../app/frame.js'
import type { Pill } from '../chrome/hud.js'
import { liveSessionId } from '../core/ids.js'
import { Attachments } from '../draft/attachments.js'
import type { Overlay } from '../overlay.js'
import { INPUT_ID } from '../surface/host.js'
import { dockNodes } from '../view/dock.js'
import { dockModel, shownPills } from '../view/dockModel.js'

import { dockActions, dockContext, dockSources } from './dockFakes.js'
import { FakeGateway } from './fakes.js'

const NOW = 1_000_000
const busy = { label: 'Working…', since: {}, startedAt: NOW - 5000 }
const compacting = { kind: 'running', manual: true, since: {}, startedAt: NOW - 2000 } as const

/** Every node under `nodes`, depth first. */
function walk(nodes: readonly JSX.Element[]): Node[] {
  return nodes.flatMap(n => (n instanceof Node ? [n, ...walk(n.children)] : []))
}

/** The nodes with role `role`. */
const byRole = (nodes: readonly JSX.Element[], role: string) => walk(nodes).filter(n => n.props['role'] === role)

/** Clicks `n` as Tern would. */
const click = (n: Node | undefined) => n?.handlers?.onClick?.({ act: 'click', ev: 'action', id: 'x', raw: {}, sf: 'hermes' })

describe('dockModel: what holds the session', () => {
  it('is idle with no turn and no compaction', () => {
    expect(dockModel(dockSources(), NOW).activity).toEqual({ kind: 'idle' })
  })

  it('is the turn while one runs, a compaction or not', () => {
    const turn = { kind: 'turn', label: 'Working…', since: busy.since, startedAt: busy.startedAt }

    expect(dockModel(dockSources({ activity: { busy, compacting: undefined } }), NOW).activity).toEqual(turn)
    expect(dockModel(dockSources({ activity: { busy, compacting } }), NOW).activity).toEqual(turn)
  })

  it('is the compaction with no turn, keeping its age', () => {
    const { activity } = dockModel(dockSources({ activity: { busy: null, compacting } }), NOW)

    expect(activity).toEqual({ kind: 'compacting', since: compacting.since, startedAt: compacting.startedAt })
    expect(activity.kind === 'compacting' && activity.since).toBe(compacting.since)
  })

  it('draws the working row for each: Stop for a turn, none for a compaction, no row when idle', () => {
    const on = dockActions()
    const turn = dockNodes(dockModel(dockSources({ activity: { busy, compacting: undefined } }), NOW), on)
    const compaction = dockNodes(dockModel(dockSources({ activity: { busy: null, compacting } }), NOW), on)

    expect(byRole(turn, 'omp.hud.status')).toHaveLength(1)
    click(byRole(turn, 'omp.working.stop')[0])
    expect(on.onInterrupt).toHaveBeenCalledTimes(1)
    expect(byRole(compaction, 'omp.hud.status')).toHaveLength(1)
    expect(byRole(compaction, 'omp.working.stop')).toEqual([])
    expect(byRole(dockNodes(dockModel(dockSources(), NOW), on), 'omp.hud.status')).toEqual([])
  })
})

describe('dockModel: the queue', () => {
  const rows = () => [{ kind: 'local', steer: true, text: 'a' }, { kind: 'local', steer: true, text: 'b' }] as const

  it('can steer only while a turn runs', () => {
    expect(dockModel(dockSources({ queue: { rows: () => [...rows()] } }), NOW).queue.canSteer).toBe(false)
    expect(dockModel(dockSources({ activity: { busy, compacting: undefined }, queue: { rows: () => [...rows()] } }), NOW).queue.canSteer).toBe(true)
    // A compaction with no turn is nothing to steer into.
    expect(dockModel(dockSources({ activity: { busy: null, compacting } }), NOW).queue.canSteer).toBe(false)
  })

  it('draws Steer only when it can, and the constant actions take the row\'s index', () => {
    const on = dockActions()
    const idle = dockNodes(dockContext({ queue: { canSteer: false, rows: [...rows()] } }), on)
    const running = dockNodes(dockContext({ queue: { canSteer: true, rows: [...rows()] } }), on)

    expect(byRole(idle, 'omp.queue.steer')).toEqual([])
    click(byRole(running, 'omp.queue.steer')[1])
    click(byRole(running, 'omp.queue.edit')[0])
    expect(on.onQueueSteer).toHaveBeenCalledWith(1)
    expect(on.onQueueEdit).toHaveBeenCalledWith(0)
  })
})

describe('dockModel: the composer and pills', () => {
  it('is ready once a session is open; a modal sheet hides the ghost and the pill focus', () => {
    const src = dockSources({ completion: { ghost: 'lp' }, hud: { focused: 'agents', todosOpen: false } })

    expect(dockModel(src, NOW).composer).toMatchObject({ ghost: 'lp', ready: false })
    expect(dockModel(src, NOW).pills.focused).toBe('agents')
    expect(dockModel({ ...src, session: { info: null, ref: { live: liveSessionId('s1') }, usage: null } }, NOW).composer.ready).toBe(true)

    const modal = dockModel({ ...src, overlays: [{ modal: true }] }, NOW)
    expect(modal.composer.ghost).toBe('')
    expect(modal.pills.focused).toBeUndefined()
  })

  it('reads the context window and the rates from usage, and the route from info', () => {
    const src = dockSources({
      session: {
        info: { model: 'gpt', reasoning_effort: 'high', reasoning_effort_wire: '' },
        ref: { live: null },
        usage: { avg_tps: 0, cache_hit_pct: 40, context_max: 1000, context_used: 250, total: 1200 }
      }
    })
    const { route, status } = dockModel(src, NOW)

    expect(route).toMatchObject({ effort: 'high', effortWire: undefined, model: 'gpt' })
    expect(status).toMatchObject({ context: { max: 1000, used: 250 }, rates: { cache: 40, tps: undefined }, tokens: 1200 })
    expect(dockModel(dockSources(), NOW).status.context).toBeUndefined()
  })
})

describe('dockModel: removing an attached image', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-tern-dock-'))
  const shot = join(dir, 'shot.png')
  writeFileSync(shot, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))

  /** Two landed images and one still uploading, with the upload's release. */
  async function draft() {
    const gw = new FakeGateway({ canonical: true })
    let uploads = 0
    let land: (v: unknown) => void = () => undefined
    gw.handlers.set('image.attach_bytes', () => (++uploads < 3 ? { path: `/uploads/${uploads}.png` } : new Promise(resolve => (land = resolve))))

    const changed = vi.fn()
    const a = new Attachments({
      attachToHead: () => false,
      blob: () => undefined,
      changed,
      cwd: () => dir,
      gw: gw.client,
      launchCwd: dir,
      note: () => undefined,
      sid: () => 's1'
    })
    await a.fromPath(shot)
    await a.fromPath(shot)
    const uploading = a.fromPath(shot)
    await vi.waitFor(() => expect(gw.sent('image.attach_bytes')).toHaveLength(3))

    /** The chip at `index` as drawn, its ✕ wired to `a`. */
    const remove = (index: number) => {
      const nodes = dockNodes(dockContext({ composer: { ...dockContext().composer, attachments: a.chips() } }), dockActions({ onRemoveAttachment: i => a.remove(i) }))

      click(byRole(nodes, 'hermes.composer.remove')[index])
    }

    return { a, changed, land: (path: string) => (land({ path }), uploading), remove }
  }

  it('draws the landed chips, then the pending one, and drops the landed one at its index', async () => {
    const { a, changed, remove } = await draft()

    expect(a.chips().map(c => c.pending ?? false)).toEqual([false, false, true])
    changed.mockClear()
    remove(1)

    expect(a.items.map(i => i.path)).toEqual(['/uploads/1.png'])
    expect(a.chips().map(c => c.pending ?? false)).toEqual([false, true])
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('drops the pending one past the landed ones: its upload then lands nowhere', async () => {
    const { a, land, remove } = await draft()

    remove(2)
    expect(a.uploading).toBe(false)
    await land('/uploads/late.png')

    expect(a.items.map(i => i.path)).toEqual(['/uploads/1.png', '/uploads/2.png'])
  })
})

/** A frame's context on recording fakes; `log` lists the side effects in the order they ran. */
function frame(over: Partial<FrameCx> = {}) {
  const log: string[] = []
  let focused: Pill | undefined = 'todos'
  const cx: FrameCx = {
    ...dockSources(),
    actions: dockActions(),
    aside: () => false,
    completion: { ghost: '', nodes: () => [], update: () => void log.push('completion.update') },
    copies: { copied: undefined, copy: () => undefined },
    overlays: [],
    hud: {
      get focused() {
        return focused
      },
      prune: shown => {
        log.push('hud.prune')
        focused = focused && shown.includes(focused) ? focused : undefined
      },
      todosOpen: false
    },
    prAside: { node: () => null, open: false },
    sidebar: { node: () => null },
    surface: { closed: false, follow: id => void log.push(`follow ${id}`), render: () => void log.push('render') },
    transcript: { currentTodos: () => undefined, entries: [] },
    welcome: { tip: '', version: '' },
    ...over
  }

  return { cx, log }
}

describe('drawFrame', () => {
  it('prunes the pills once, updates the completion, renders, then moves the caret', () => {
    const { cx, log } = frame()

    drawFrame(cx, NOW)

    // The todo pill left, so the composer takes the caret back.
    expect(log).toEqual(['hud.prune', 'completion.update', 'render', `follow ${INPUT_ID}`])
  })

  it('leaves the caret off the composer while a pill still holds the keys', () => {
    const { cx, log } = frame({ transcript: { currentTodos: () => [{ content: 'Fix it', id: 't1', status: 'pending' }], entries: [] } })

    expect(shownPills(cx, NOW)).toEqual(['todos'])
    drawFrame(cx, NOW)
    expect(log).toEqual(['hud.prune', 'completion.update', 'render', 'follow null'])
  })

  it('leaves the completion alone under a modal sheet, and gives the caret to the sheet\'s field', () => {
    const sheet: Pick<Overlay, 'focus' | 'key' | 'modal' | 'node'> = { focus: id => `${id}.field`, key: 'ask', modal: true, node: () => new Node('col', { key: 'ask' }) }
    const { cx, log } = frame({ overlays: [sheet] })

    drawFrame(cx, NOW)
    expect(log).toEqual(['hud.prune', 'render', 'follow layer.ask.field'])
  })

  it('draws nothing once the surface closed', () => {
    const { cx, log } = frame()

    drawFrame({ ...cx, surface: { ...cx.surface, closed: true } }, NOW)
    expect(log).toEqual([])
  })
})
