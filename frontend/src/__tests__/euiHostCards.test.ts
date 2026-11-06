import { View } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { euiHostPort } from '../app/eui-host.js'
import { liveSessionId } from '../core/ids.js'
import { EuiCards, type EuiCardView } from '../eui/cards.js'
import { MAX_HOST_CARDS, type EuiApprovalContext } from '../eui/host.js'
import { HOST_APPROVE_ID } from '../eui/hostSnapshot.js'
import { SessionState } from '../session/state.js'
import { Transcript } from '../transcript/store.js'
import { euiCardNode } from '../view/euiCard.js'
import { decodeEuiCard } from '../wire/euiCard.js'
import { decodeEuiHostCard, MAX_HOST_ROWS } from '../wire/euiHostCard.js'

import { approvalCard } from './euiHostFixtures.js'
import { must, ofKind, stub, tree } from './fakes.js'

function setup() {
  const session = new SessionState(() => undefined)
  session.ref = { live: liveSessionId('fixture-session'), stored: null }
  const transcript = new Transcript()
  const changed = vi.fn()
  const gate = { active: true }
  const eui = new EuiCards(changed, undefined, euiHostPort({ session, transcript }, () => gate.active))
  const entry = () => ofKind(transcript.entries.at(-1), 'panel')
  const view = () => must(eui.hostView(entry()))
  return { session, transcript, changed, gate, eui, entry, view }
}

function tap(view: EuiCardView) {
  must(view.activate)(HOST_APPROVE_ID)
}

describe('host-owned card data', () => {
  it('renders supplied frozen values through the existing renderer without running an operation', () => {
    const { eui, view } = setup()
    const raw = approvalCard()
    const run = vi.fn((_context: EuiApprovalContext) => undefined)
    eui.host.publish(raw, run)
    raw.title = 'Changed after publication'
    must(raw.rows[0]).value = 900
    raw.approval.description = 'Different operation'
    const first = view()
    const drawn = JSON.stringify(tree(euiCardNode('host', first, eui)))
    expect(drawn).toContain('Prepare local workspace')
    expect(drawn).toContain('three reviewed local files')
    expect(drawn).not.toContain('Changed after publication')
    expect(drawn).not.toContain('900')
    expect(drawn).toContain('false')
    eui.theme(true)
    euiCardNode('host', view(), eui)
    eui.click('host', HOST_APPROVE_ID)
    expect(run).not.toHaveBeenCalled()
    tap(first)
    expect(run).toHaveBeenCalledTimes(1)
    const context = must(run.mock.calls[0]?.[0])
    expect(must(context.data.approval).description).toBe('Create only the three reviewed local files.')
    expect(Object.isFrozen(context.data)).toBe(true)
    expect(Object.isFrozen(context.data.rows[0])).toBe(true)
    eui.close()
  })

  it('renders literal text, zero and false without interpreting markup or model grants', () => {
    const { eui, view, entry } = setup()
    const data = { kind: 'intent-proof', app: 'glide', title: '<script>fetch("remote")</script>',
      rows: [{ label: 'Count', value: 0 }, { label: 'Enabled', value: false }] }
    eui.host.publish(data)
    expect(JSON.stringify(view().node)).toContain('<script>')
    expect(JSON.stringify(view().node)).toContain('"text":"0"')
    expect(JSON.stringify(view().node)).toContain('"text":"false"')
    expect(JSON.stringify(view().node)).not.toContain('"tag":"script"')
    expect(decodeEuiCard(JSON.stringify({ ...approvalCard(), callback: 'run', host: 1 }), eui.kinds))
      .toEqual({ kind: 'approve', app: 'glide', title: 'Prepare local workspace' })
    expect(eui.hostView({ ...entry() }))
      .toBeUndefined()
    eui.close()
  })

  it('rejects invalid shapes, nonfinite values, oversized rows and UTF-8 payloads', () => {
    const { eui } = setup()
    const invalid: unknown[] = [
      { ...approvalCard(), callback: 'execute' },
      { ...approvalCard(), rows: [{ label: 'Count', value: Infinity }] },
      { ...approvalCard(), rows: [{ label: 'Count', value: NaN }] },
      { ...approvalCard(), rows: [{ label: 'Value', value: { html: '<button>' } }] },
      { ...approvalCard(), rows: Array.from({ length: MAX_HOST_ROWS + 1 }, () => ({ label: 'x', value: 1 })) },
      { ...approvalCard(), rows: [{ label: 'x', value: 'x'.repeat(2049) }] },
      { ...approvalCard(), approval: { label: 'Run', description: ' ' } },
      { ...approvalCard(), kind: 'intent-proof' },
      { ...approvalCard(), kind: 'unknown-kind' }
    ]
    for (const data of invalid) expect(() => decodeEuiHostCard(data, eui.kinds)).toThrow()
    const unicode = { ...approvalCard(), rows: Array.from({ length: 3 }, () => ({ label: 'x', value: '界'.repeat(2048) })) }
    expect(JSON.stringify(unicode).length).toBeLessThan(16 * 1024)
    expect(() => decodeEuiHostCard(unicode, eui.kinds)).toThrow('UTF-8')
    expect(() => eui.host.publish(approvalCard())).toThrow('separate host operation')
    expect(() => eui.host.publish({ kind: 'intent-proof', app: 'glide', title: 'Done', rows: [] }, () => undefined)).toThrow()
    expect(eui.host.size).toBe(0)
    eui.close()
  })
})

describe('one-use host approvals', () => {
  it('consumes before a reentrant or repeated tap and stays consumed after rejection', async () => {
    const { eui, view } = setup()
    const pending = Promise.withResolvers<void>()
    let first: EuiCardView | undefined
    const run = vi.fn(() => { if (first) tap(first); return pending.promise })
    eui.host.publish(approvalCard(), run)
    first = view()
    tap(first)
    tap(first)
    expect(run).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(view().node)).toContain('Running')
    pending.reject(new Error('fixture failure'))
    await pending.promise.catch(() => undefined)
    expect(JSON.stringify(view().node)).toContain('Failed · approval used')
    tap(first)
    expect(run).toHaveBeenCalledTimes(1)
    eui.close()
  })

  it('keeps synchronous failures consumed', () => {
    const { eui, view } = setup()
    const run = vi.fn(() => { throw new Error('fixture failure') })
    eui.host.publish(approvalCard(), run)
    const first = view()
    tap(first)
    tap(first)
    expect(run).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(view().node)).toContain('Failed · approval used')
    eui.close()
  })

  it('changes the native key and retires an old callback when the same card is updated', () => {
    const { eui, view } = setup()
    const oldRun = vi.fn()
    const nextRun = vi.fn()
    const handle = eui.host.publish(approvalCard(), oldRun)
    const old = view()
    const oldId = 'main.host.' + old.identity
    const oldNative = View.from({ main: [euiCardNode('host', old, eui)] })
    expect(oldNative.regions.flatMap(root => root?.children.map(child => child.id) ?? [])).toContain(oldId)
    handle.update({ ...approvalCard(), title: 'New reviewed plan' }, nextRun)
    const next = view()
    expect(next.identity).not.toBe(old.identity)
    const native = View.from({ main: [euiCardNode('host', next, eui)] })
    const ids = native.regions.flatMap(root => root?.children.map(child => child.id) ?? [])
    expect(ids).not.toContain(oldId)
    expect(ids).toContain('main.host.' + next.identity)
    tap(old)
    expect(oldRun).not.toHaveBeenCalled()
    expect(nextRun).not.toHaveBeenCalled()
    tap(next)
    tap(next)
    expect(nextRun).toHaveBeenCalledTimes(1)
    eui.close()
  })

  it('aborts a replaced operation and ignores its late completion', async () => {
    const { eui, view, changed } = setup()
    const pending = Promise.withResolvers<void>()
    let context: EuiApprovalContext | undefined
    const handle = eui.host.publish(approvalCard(), owner => { context = owner; return pending.promise })
    tap(view())
    const replacement = vi.fn()
    handle.update({ ...approvalCard(), title: 'Replacement' }, replacement)
    expect(must(context).signal.aborted).toBe(true)
    const calls = changed.mock.calls.length
    pending.resolve()
    await pending.promise
    expect(changed).toHaveBeenCalledTimes(calls)
    expect(JSON.stringify(view().node)).toContain('Create workspace')
    expect(JSON.stringify(view().node)).not.toContain('Completed')
    eui.close()
  })

  it('requires the current visible host gate and a real approval button id', () => {
    const { eui, view, gate } = setup()
    const run = vi.fn()
    eui.host.publish(approvalCard(), run)
    const current = view()
    must(current.activate)(999)
    gate.active = false
    tap(current)
    expect(run).not.toHaveBeenCalled()
    gate.active = true
    tap(current)
    expect(run).toHaveBeenCalledTimes(1)
    eui.close()
  })

  it('bounds registrations and never revives an evicted or revoked grant', () => {
    const { eui, view } = setup()
    const firstRun = vi.fn()
    const first = eui.host.publish(approvalCard(), firstRun)
    const firstView = view()
    for (let i = 0; i < MAX_HOST_CARDS; i++) eui.host.publish(approvalCard(), () => undefined)
    expect(eui.host.size).toBe(MAX_HOST_CARDS)
    tap(firstView)
    expect(firstRun).not.toHaveBeenCalled()
    expect(() => first.update(approvalCard(), firstRun)).toThrow('no longer current')
    const run = vi.fn()
    const next = eui.host.publish(approvalCard(), run)
    const nextView = view()
    expect(next.revision).toBeGreaterThan(first.revision)
    next.revoke()
    tap(nextView)
    expect(run).not.toHaveBeenCalled()
    eui.close()
  })
})

const retirements = ['other session', 'same session', 'round trip', 'profile', 'reset', 'load', 'transport', 'dispose'] as const

describe('host approval lifetime', () => {
  it.each(retirements)('rejects an old button and aborts in-flight work after %s', retirement => {
    const { session, transcript, eui, view } = setup()
    const waitingRun = vi.fn()
    eui.host.publish(approvalCard(), waitingRun)
    const waiting = view()
    let context: EuiApprovalContext | undefined
    eui.host.publish(approvalCard(), owner => { context = owner })
    tap(view())
    switch (retirement) {
      case 'other session': session.ref = { live: liveSessionId('other'), stored: null }; break
      case 'same session': session.ref = { ...session.ref }; break
      case 'round trip':
        session.ref = { live: liveSessionId('other'), stored: null }
        session.ref = { live: liveSessionId('fixture-session'), stored: null }
        break
      case 'profile': session.info = stub<NonNullable<SessionState['info']>>({ profile_name: 'fixture-profile' }); break
      case 'reset': transcript.reset({ session: 'same', usage: undefined }); break
      case 'load': transcript.load([]); break
      case 'transport': eui.host.invalidate(); break
      case 'dispose': eui.close(); break
    }
    eui.host.sync()
    tap(waiting)
    expect(waitingRun).not.toHaveBeenCalled()
    expect(must(context).signal.aborted).toBe(true)
    expect(eui.host.size).toBe(0)
    eui.close()
  })
})
