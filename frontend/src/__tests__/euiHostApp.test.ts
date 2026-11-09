import type { ActionEvent } from '@stencil-hq/tern'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EuiApprovalContext } from '../eui/host.js'
import { HOST_APPROVE_ID } from '../eui/hostSnapshot.js'
import { storedSessionId } from '../core/ids.js'
import { RETAIN_TURNS } from '../view/retention-policy.js'

import { settle, setup } from './appSetup.js'
import { approvalCard } from './euiHostFixtures.js'
import { given, must, ofKind, stubOverlay } from './fakes.js'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))

const apps: ReturnType<typeof setup>['app'][] = []
beforeEach(() => {
  delete process.env['HERMES_TUI_QUERY']
  delete process.env['HERMES_TUI_IMAGE']
})
afterEach(() => {
  for (const app of apps.splice(0)) app.dispose()
  vi.restoreAllMocks()
})

/** Finds an actual emitted native id, not an invented test handler map. */
function buttonId(value: unknown, label: string, owner?: string): string | undefined {
  if (Array.isArray(value)) return value.map(v => buttonId(v, label, owner)).find(Boolean)
  if (!value || typeof value !== 'object') return undefined
  const id = 'id' in value && typeof value.id === 'string' ? value.id : owner
  if (Object.values(value).includes(label)) return id
  return Object.values(value).map(v => buttonId(v, label, id)).find(Boolean)
}

function click(id: string): ActionEvent {
  return { ev: 'action', sf: 'hermes', id, act: 'click', raw: {} }
}

describe('App host card authority', () => {
  it.each([false, true])('rejects stale native taps before/after repaint and executes once (retention=%s)', async retention => {
    const { app, ops, tern, sent } = setup({}, { features: retention ? ['settle'] : [] })
    apps.push(app)
    const oldRun = vi.fn()
    const run = vi.fn()
    const handle = app.eui.host.publish(approvalCard(), oldRun)
    await settle()
    const oldId = must(buttonId(ops(), 'Create workspace'))
    expect(oldId).toContain('host-' + handle.revision)
    if (retention) {
      // Move the host panel beyond the retained turns, then prove the peer settled it.
      const beforeSettlement = ops().length
      for (let i = 0; i < RETAIN_TURNS + 1; i++) {
        app.transcript.push({
          kind: 'turn', id: app.transcript.id('fixture'), rev: 0, startedAt: i,
          blocks: [{ kind: 'text', id: app.transcript.id('text'), text: 'Synthetic completed turn ' + i }],
          end: { status: 'done', endedAt: i + 1 }
        })
      }
      app.changed()
      await settle()
      expect(ops().slice(beforeSettlement)).toContainEqual(['settle', 'main.' + handle.id])
    }
    const before = ops().length
    handle.update({
      ...approvalCard(), title: 'Updated plan',
      approval: { label: 'Apply reviewed plan', description: 'Create only the revised local files.' }
    }, run)
    // Deliver the old event while the previous native paint may still be visible.
    await tern.dispatch(click(oldId))?.()
    await settle()
    expect(oldRun).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    const nextId = must(buttonId(ops().slice(before), 'Apply reviewed plan'))
    expect(nextId).not.toBe(oldId)
    expect(JSON.stringify(ops().slice(before))).toContain('Updated plan')
    await tern.dispatch(click(oldId))?.()
    const current = tern.dispatch(click(nextId))
    expect(current).toBeTypeOf('function')
    await current?.()
    await current?.()
    await tern.dispatch(click(nextId))?.()
    await settle()
    expect(oldRun).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(ops().slice(before))).toContain('Completed')
    expect(sent('prompt.submit')).toHaveLength(0)
    expect(sent('slash.exec')).toHaveLength(0)
    expect(sent('shell.exec')).toHaveLength(0)
  })

  it('cannot run under a modal or during a pending session switch', async () => {
    const pending = Promise.withResolvers<unknown>()
    const { app } = setup({ 'session.resume': () => pending.promise })
    apps.push(app)
    const run = vi.fn()
    app.eui.host.publish(approvalCard(), run)
    const panel = ofKind(app.transcript.entries.at(-1), 'panel')
    const view = must(app.eui.hostView(panel))
    const overlay = stubOverlay('fixture-modal', { modal: true })
    app.open(overlay)
    must(view.activate)(HOST_APPROVE_ID)
    expect(run).not.toHaveBeenCalled()
    app.close(overlay)
    const switching = app.resume(storedSessionId('other'))
    expect(app.stores.life.switching).toBe(true)
    must(view.activate)(HOST_APPROVE_ID)
    expect(run).not.toHaveBeenCalled()
    pending.resolve({ session_id: 's2', messages: [] })
    await switching
    must(view.activate)(HOST_APPROVE_ID)
    expect(run).not.toHaveBeenCalled()
  })

  it.each(['same-id adoption', 'transcript reload', 'transport exit', 'dispose'] as const)(
    'retires a saved handler and aborts running work on %s', async reason => {
      const { app, emit } = setup()
      apps.push(app)
      const run = vi.fn()
      app.eui.host.publish(approvalCard(), run)
      const panel = ofKind(app.transcript.entries.at(-1), 'panel')
      const old = must(app.eui.hostView(panel))
      let context: EuiApprovalContext | undefined
      const pending = Promise.withResolvers<void>()
      app.eui.host.publish(approvalCard(), owner => { context = owner; return pending.promise })
      const working = ofKind(app.transcript.entries.at(-1), 'panel')
      must(must(app.eui.hostView(working)).activate)(HOST_APPROVE_ID)
      switch (reason) {
        case 'same-id adoption': given.session(app, 's1'); break
        case 'transcript reload': app.transcript.load([]); app.changed(); break
        case 'transport exit': emit('exit', 1); break
        case 'dispose': app.dispose(); apps.splice(apps.indexOf(app), 1); break
      }
      must(old.activate)(HOST_APPROVE_ID)
      expect(run).not.toHaveBeenCalled()
      expect(must(context).signal.aborted).toBe(true)
      pending.resolve()
      await pending.promise
      expect(app.eui.host.size).toBe(0)
    }
  )
})
