import type { Usage } from '@hermes/shared/gateway-events'
import { Node } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { liveSessionId } from '../core/ids.js'
import { contextFacts, openContext, type ContextHost } from '../overlays/context.js'
import { OverlayStack } from '../overlays/overlay.js'
import { contextPercent, contextShare, contextWindow, CONTEXT_THRESHOLDS } from '../session/context.js'
import { SessionState } from '../session/state.js'
import { contextMeter } from '../view/context.js'
import { dockNodes } from '../view/dock.js'
import { dockModel } from '../view/dockModel.js'

import { dockActions, dockSources } from './dockFakes.js'
import { FakeGateway, key, must, tree } from './fakes.js'

const snapshot = {
  categories: [{ color: 'accent', id: 'messages', label: 'Conversation', tokens: 200 }],
  context_estimated: true, context_max: 1000, context_percent: 25,
  context_source: 'estimate', context_used: 250, estimated_total: 250, model: 'fake-model'
}

function setup(usage: Usage | null = null) {
  const changed = vi.fn()
  const session = new SessionState(changed)
  session.ref = { live: liveSessionId('s1'), stored: null }
  session.usage = usage
  const stack = new OverlayStack({ changed, closed: () => undefined, opened: () => undefined })
  const gw = new FakeGateway({ replies: { 'session.context_breakdown': () => snapshot } })
  const host: ContextHost = { changed, close: o => stack.close(o), gw: gw.client, open: o => stack.open(o), session }

  return { changed, gw, host, session, stack }
}

const flush = () => new Promise(resolve => setImmediate(resolve))
const click = (n: Node) => n.handlers?.onClick?.({ act: 'click', ev: 'action', id: 'context', raw: {}, sf: 'hermes' })

describe('context-window math', () => {
  it.each([
    [0, 1000, 0, 0], [5, 1000, 1, 0.005], [600, 1000, 60, 0.6],
    [850, 1000, 85, 0.85], [1000, 1000, 100, 1], [1200, 1000, 120, 1]
  ])('keeps % and bounds the painted bar for %i / %i', (used, max, percent, share) => {
    const context = must(contextWindow({ context_max: max, context_used: used }))
    expect(contextPercent(context)).toBe(percent)
    expect(contextShare(context)).toBe(share)
  })

  it.each([null, {}, { context_max: 1000 }, { context_used: 20 }, { context_max: 0, context_used: 0 },
    { context_max: 1000, context_used: -1 }, { context_max: Infinity, context_used: 1 }, { context_max: 1000, context_used: NaN }
  ])('does not turn missing or invalid counts into 0%%', usage => {
    expect(contextWindow(usage)).toBeUndefined()
  })

  it('uses visual warning thresholds, not an invented compaction threshold', () => {
    expect(CONTEXT_THRESHOLDS).toEqual({ bad: 0.85, warn: 0.6 })
    expect(tree(contextMeter({ max: 1000, used: 600 }, vi.fn())).c?.[0]?.p).toMatchObject({
      thresholds: { bad: 0.85, warn: 0.6 }, value: 0.6
    })
    expect(contextFacts({ compressions: 0, context_max: 1000, context_used: 0 })).toContainEqual({ k: 'Compactions', v: '0' })
    expect(contextFacts(null)).toContainEqual({ k: 'Auto-compaction threshold', v: 'Unknown (not exposed by the gateway)' })
    expect(contextFacts({ total: 999999, context_max: 1000 })).toContainEqual({ k: 'Context used', v: 'Unknown' })
  })
})

describe('native context action and sheet', () => {
  it('is a named native button with one meter, including 0% and unknown data', () => {
    for (const context of [undefined, { max: 1000, used: 0 }]) {
      const onOpen = vi.fn()
      const n = contextMeter(context, onOpen)
      const json = tree(n)
      expect(json.p).toMatchObject({ attrs: { 'aria-haspopup': 'dialog' }, tag: 'button' })
      expect(json.p?.['aria']).toBe(context ? 'Show context window: 0% context' : 'Show context window: Context unknown')
      expect(json.c?.[0]?.p?.['label']).toBe(context ? '0%' : '?')
      if (n instanceof Node) click(n)
      expect(onOpen).toHaveBeenCalledOnce()
    }
  })

  it('wires the drawn composer action to the read-only sheet without a prompt', async () => {
    const { host, stack, gw, session } = setup({ context_max: 1000, context_used: 250, compressions: 2 })
    const on = dockActions({ onContext: () => openContext(host) })
    const composer = dockNodes(dockModel(dockSources({ session }), 0), on).find(n => n instanceof Node && n.props['role'] === 'omp.editor')
    expect(composer).toBeInstanceOf(Node)
    if (!(composer instanceof Node)) throw new Error('no composer')
    const action = must(composer.children.find(n => n.props['role'] === 'omp.composer.context.action'))
    click(action)
    await flush()
    const sheet = must(stack.items[0])
    expect(tree(sheet.node('layer.context')).p?.['head']).toBe('Context window')
    expect(gw.calls.map(c => c.method)).toEqual(['session.context_breakdown'])
    expect(JSON.stringify(tree(sheet.node('layer.context')))).toContain('Conversation')
    expect(JSON.stringify(tree(sheet.node('layer.context')))).toContain('Estimated')
    expect(on.onSubmit).not.toHaveBeenCalled()
    expect(sheet.onKey(key('enter'))).toBe(true)
    expect(stack.items).toEqual([])
    expect(gw.sent('prompt.submit')).toEqual([])
  })

  it('keeps unknowns explicit, then closes with Escape', () => {
    const { host, stack, session } = setup()
    session.ref = { live: null, stored: null }
    openContext(host)
    const sheet = must(stack.items[0])
    const json = JSON.stringify(tree(sheet.node('layer.context')))
    expect(json).toContain('Unknown')
    expect(json).toContain('No active session')
    sheet.onKey(key('escape'))
    expect(stack.items).toEqual([])
  })

  it('keeps the event-sourced totals when the breakdown is unavailable', async () => {
    const { host, gw, stack } = setup({ context_max: 1000, context_used: 250 })
    gw.handlers.set('session.context_breakdown', () => { throw new Error('Method not found') })
    openContext(host)
    await flush()
    const json = JSON.stringify(tree(must(stack.items[0]).node('layer.context')))
    expect(json).toContain('25%')
    expect(json).toContain('Category breakdown unavailable: Method not found')
  })

  it.each(['close', 'switch', 'replace'])('ignores a late snapshot after %s', async action => {
    const { host, gw, stack, changed, session } = setup()
    const { promise, resolve } = Promise.withResolvers<typeof snapshot>()
    gw.handlers.set('session.context_breakdown', () => promise)
    openContext(host)
    const old = must(stack.items[0])
    if (action === 'close') host.close(old)
    if (action === 'switch') session.ref = { live: liveSessionId('s2'), stored: null }
    if (action === 'replace') {
      gw.handlers.set('session.context_breakdown', () => Promise.withResolvers<typeof snapshot>().promise)
      openContext(host)
    }
    changed.mockClear()
    resolve(snapshot)
    await flush()
    expect(changed).not.toHaveBeenCalled()
  })

  it('updates the meter from fresh gateway usage without cumulative tokens', () => {
    const src = dockSources({ session: { info: null, ref: { live: liveSessionId('s1') }, usage: { context_max: 1000, context_used: 250, total: 999999 } } })
    expect(dockModel(src, 0).status.context).toEqual({ max: 1000, used: 250 })
    expect(dockModel({ ...src, session: { ...src.session, usage: { context_max: 1000, context_used: 850 } } }, 0).status.context).toEqual({ max: 1000, used: 850 })
  })
})
