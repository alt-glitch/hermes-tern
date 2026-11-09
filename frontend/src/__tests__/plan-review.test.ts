import { Node, node, type JSX } from '@stencil-hq/tern'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { localCommand } from '../commands/local.js'
import type { CommandHost } from '../commands/local.js'
import type { SessionHost } from '../commands/session.js'
import { entryId, liveSessionId } from '../core/ids.js'
import { Composer } from '../draft/composer.js'
import type { Entry } from '../model.js'
import type { Overlay } from '../overlays/overlay.js'
import { openPlanReview, type PlanReviewHost } from '../overlays/plan.js'
import { editPlanExternal } from '../plan-editor.js'
import { latestPlan, parsePlan, planStatusOf, reviewPlanText } from '../plan.js'
import { PLAN_GATEWAY_REQUIRED, PLAN_METHODS, supportsPlanMethods } from '../wire/plan.js'
import { Transcript } from '../transcript/store.js'

import { FakeGateway, key, must, stub, stubOverlay, type Reply } from './fakes.js'

vi.mock('../plan-editor.js', () => ({ editPlanExternal: vi.fn() }))
afterEach(() => vi.mocked(editPlanExternal).mockReset())

const paint = async () => {
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
}

const doneTurn = (text: string): Entry => ({
  blocks: [{ id: entryId('content'), kind: 'text', text }],
  end: { status: 'done' },
  id: entryId('assistant'),
  kind: 'turn',
  rev: 1,
  startedAt: 1
})

type PlanFixture = {
  enabled: boolean
  generating: boolean
  plan: {
    annotations: { section: number; text: string }[]
    decision: 'pending'
    id: string
    revision: number
    text: string
  }
}

const initial = (): PlanFixture => ({
  enabled: true,
  generating: false,
  plan: {
    annotations: [],
    decision: 'pending',
    id: 'plan-1',
    revision: 3,
    text: 'Intro\n# Implement\nGoal\n## Build\nChange one file\n## Verify\nRun tests'
  }
})

function fixture(replies: Record<string, Reply> = {}, { busy = false, queued = 0 }: { busy?: boolean; queued?: number } = {}) {
  const overlays: Overlay[] = []
  const gw = new FakeGateway({ replies: {
    'gateway.capabilities': () => ({ plugin_methods: Object.values(PLAN_METHODS) }),
    ...replies
  } })
  const transcript = new Transcript()
  const session = { info: null, ref: { live: liveSessionId('runtime-a'), stored: null } }
  const changed = vi.fn()
  const scroll = vi.fn()
  const notices = vi.fn()
  const send = vi.fn<(text: string) => void>()
  const enqueue = vi.fn<(text: string) => void>()
  const draft = new Composer()
  draft.set('Keep this draft and caret', { cursor: 7, pasted: ['!literal'] })

  transcript.push(doneTurn('Preamble\n# Assistant plan\n## Phase one\nComplete the task'))

  const host: PlanReviewHost = {
    busy: busy ? stub<NonNullable<PlanReviewHost['busy']>>({ since: 1 }) : null,
    changed,
    control: () => stub<SessionHost>({
      busy,
      enqueue,
      queued,
      get sid() { return session.ref.live },
      send,
      stale: () => false
    }),
    close: overlay => {
      const index = overlays.indexOf(overlay)

      if (index !== -1) {
        overlays.splice(index, 1)
        overlay.onClose?.()
        changed()
      }
    },
    gw: gw.client,
    notice: notices,
    open: overlay => {
      const index = overlays.findIndex(item => item.key === overlay.key)

      if (index !== -1) {
        overlays.splice(index, 1)[0]?.onClose?.()
      }

      overlays.push(overlay)
      changed()
    },
    overlays,
    scroll,
    session,
    transcript
  }

  const walk = (elements: readonly JSX.Element[]): Node[] =>
    elements.flatMap(element => element instanceof Node ? [element, ...walk(element.children)] : [])

  const nodes = () => {
    const overlay = overlays.at(-1)

    return overlay ? walk([overlay.node('layer.overlay-1')]) : []
  }
  const element = (name: string) => nodes().find(node => node.props['key'] === name)
  const click = (name: string) => {
    const found = element(name)
    const action = found?.handlers?.onClick

    if (!action) {
      throw new Error('No native action for ' + name)
    }

    return action({ act: 'click', ev: 'action', id: 'fixture', raw: {}, sf: 'hermes' })
  }
  const capture = (name: string) => {
    const found = element(name)
    const action = found?.handlers?.onClick

    if (!action) {
      throw new Error('No native action for ' + name)
    }

    return () => action({ act: 'click', ev: 'action', id: 'fixture', raw: {}, sf: 'hermes' })
  }

  return { capture, changed, click, draft, element, enqueue, gw, host, nodes, notices, overlays, scroll, send, session, transcript }
}

describe('Hermes plan parser and authority boundary', () => {
  it('ignores fenced headings, user text and unfinished turns', () => {
    const text = 'Intro\n' + '~~~md\n# Hidden\n~~~\n' + '# Actual\nBody\n## Same\nOne\n## Same\nTwo'
    const parsed = must(parsePlan(text))

    expect(parsed.preamble).toBe('Intro\n~~~md\n# Hidden\n~~~\n')
    expect(parsed.sections.map(section => section.title)).toEqual(['Actual', 'Same', 'Same'])
    expect(parsed.sections[2]?.text).toBe('## Same\nTwo')
    expect(parsePlan('~~~md\n# Only code\n~~~')).toBeUndefined()
    expect(reviewPlanText('Plain backend plan').sections[0]?.text).toBe('Plain backend plan')
    expect(latestPlan([
      doneTurn('# Approved candidate'),
      { at: 0, id: entryId('user'), kind: 'user', text: '# Fake plan' },
      {
        blocks: [{ id: entryId('live'), kind: 'text', text: '# Not complete' }],
        end: { status: 'live' },
        id: entryId('streaming'),
        kind: 'turn',
        rev: 1,
        startedAt: 2
      }
    ])?.sections[0]?.title).toBe('Approved candidate')
  })

  it('accepts only a complete revision-bound gateway status', () => {
    expect(planStatusOf(initial())?.plan?.revision).toBe(3)
    expect(planStatusOf({ ...initial(), supported: false })).toBeUndefined()
    expect(planStatusOf({ enabled: true, generating: false, plan: {} })).toBeUndefined()
    expect(planStatusOf({ ...initial(), plan: { ...initial().plan, revision: 0 } })).toBeUndefined()
    expect(planStatusOf({ ...initial(), plan: { ...initial().plan, annotations: [{ section: -1, text: 'x' }] } })).toBeUndefined()
    expect(planStatusOf({ enabled: false, generating: true, plan: null })).toEqual({ enabled: false, generating: true, plan: null })
  })
})

describe('native plan review', () => {
  it('exposes ordinary actions without a compatible backend while retaining inspection-only authority', async () => {
    const f = fixture()
    openPlanReview(f.host)
    await paint()

    expect(f.gw.sent('hermes-tern.plan.status')).toEqual([{ session_id: 'runtime-a' }])
    expect(f.element('authority')?.props['text']).toContain('Plan authority unavailable')
    expect(f.element('markdown')?.props['text']).toContain('# Assistant plan')
    expect(f.element('approve')?.props['aria']).toBe('Continue (ordinary prompt)')
    expect(f.element('refine')).toBeDefined()
    expect(f.element('mode')).toBeUndefined()
    f.click('section-1')
    expect(f.scroll).toHaveBeenCalledWith('layer.overlay-1.body.markdown', 'start')
    expect(f.element('markdown')?.props['text']).toContain('## Phase one')
    f.click('close')
    expect(f.overlays).toHaveLength(0)
    expect(f.gw.sent('prompt.submit')).toEqual([])
    expect(f.send).not.toHaveBeenCalled()
  })

  it('routes ordinary Continue exactly once through the typed normal prompt port, leaving draft and images untouched', async () => {
    const f = fixture()
    openPlanReview(f.host)
    await paint()
    const first = f.capture('approve')
    const draftBefore = [f.draft.text, f.draft.cursor, [...f.draft.pasted]]

    first()
    first()
    await paint()

    expect(f.send).toHaveBeenCalledTimes(1)

    expect(f.send).toHaveBeenCalledWith('Approved — proceed with the plan.')
    expect(f.enqueue).not.toHaveBeenCalled()
    expect(f.overlays).toHaveLength(0)
    expect(f.gw.sent('hermes-tern.plan.decide')).toEqual([])
    expect(f.gw.sent('prompt.submit')).toEqual([])
    expect([f.draft.text, f.draft.cursor, [...f.draft.pasted]]).toEqual(draftBefore)
  })

  it('sends ordinary refinement text via the prompt port, not plan.decide; empty and duplicate submissions do nothing', async () => {
    const f = fixture({ 'hermes-tern.plan.status': () => ({ enabled: false, generating: false, plan: null }) })
    openPlanReview(f.host)
    await paint()

    expect(f.element('approve')?.props['aria']).toBe('Continue (ordinary prompt)')
    f.click('refine')
    const empty = f.capture('save')
    empty()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.overlays).toHaveLength(1)

    f.overlays.at(-1)?.onKey(key('text', { text: 'Add rollback checks' }))
    const submit = f.capture('save')
    submit()
    submit()
    await paint()

    expect(f.send).toHaveBeenCalledTimes(1)

    expect(f.send).toHaveBeenCalledWith('Refine the plan: Add rollback checks')
    expect(f.gw.sent('hermes-tern.plan.decide')).toEqual([])
    expect(f.enqueue).not.toHaveBeenCalled()
    expect(f.draft.text).toBe('Keep this draft and caret')
    expect(f.draft.cursor).toBe(7)
    expect(f.draft.pasted).toEqual(['!literal'])
  })

  it('queues an ordinary Continue while busy rather than steering or borrowing composer attachments', async () => {
    const f = fixture({}, { busy: true })
    openPlanReview(f.host)
    await paint()

    f.click('approve')
    expect(f.enqueue).toHaveBeenCalledTimes(1)
    expect(f.enqueue).toHaveBeenCalledWith('Approved — proceed with the plan.')
    expect(f.send).not.toHaveBeenCalled()
    expect(f.gw.sent('hermes-tern.plan.decide')).toEqual([])
    expect(f.draft.text).toBe('Keep this draft and caret')
  })

  it('queues an ordinary decision behind existing prompts while otherwise idle', async () => {
    const f = fixture({}, { queued: 1 })
    openPlanReview(f.host)
    await paint()

    const stale = f.capture('approve')
    f.click('approve')
    stale()

    expect(f.enqueue).toHaveBeenCalledTimes(1)
    expect(f.enqueue).toHaveBeenCalledWith('Approved — proceed with the plan.')
    expect(f.send).not.toHaveBeenCalled()
    expect(f.gw.sent('prompt.submit')).toEqual([])
  })

  it('does not offer ordinary approval in enabled planning mode, or while status is loading', async () => {
    let respond!: (value: unknown) => void
    const f = fixture({
      'hermes-tern.plan.status': () => new Promise(resolve => { respond = resolve })
    })
    openPlanReview(f.host)
    expect(f.element('approve')).toBeUndefined()
    // Discovery is an asynchronous, session-scoped capability RPC.
    await paint()
    expect(f.gw.sent('hermes-tern.plan.status')).toEqual([{ session_id: 'runtime-a' }])
    respond({ enabled: true, generating: false, plan: null })
    await paint()
    expect(f.element('approve')).toBeUndefined()
    expect(f.element('refine')).toBeUndefined()
    expect(f.send).not.toHaveBeenCalled()
  })

  it('rejects captured mode, edit and approve actions after an idle modal preempts the plan sheet', async () => {
    const f = fixture({ 'hermes-tern.plan.status': initial, 'hermes-tern.plan.mode': initial })
    openPlanReview(f.host)
    await paint()

    const mode = f.capture('mode')
    const edit = f.capture('edit-plan')
    const approve = f.capture('approve')
    const refine = f.capture('refine')
    const planSheet = must(f.overlays.at(-1))
    f.host.open(stubOverlay('approval', { modal: true }))

    mode()
    edit()
    approve()
    refine()
    planSheet.onKey(key('a', { alt: true }))
    planSheet.onKey(key('text', { text: 'ignored' }))
    expect(f.gw.sent('hermes-tern.plan.mode')).toEqual([])
    expect(f.gw.sent('hermes-tern.plan.edit')).toEqual([])
    expect(f.gw.sent('hermes-tern.plan.decide')).toEqual([])
    expect(f.send).not.toHaveBeenCalled()
    expect(f.overlays).toHaveLength(2)
    f.host.close(must(f.overlays.at(-1)))
    expect(f.element('note')).toBeUndefined()
  })

  it('drops captured native editor events and keyboard input under preemption', async () => {
    const f = fixture({ 'hermes-tern.plan.status': initial })
    openPlanReview(f.host)
    await paint()
    f.click('refine')
    const planSheet = must(f.overlays.at(-1))
    const onEdit = f.element('note')?.handlers?.onEdit

    expect(onEdit).toBeDefined()
    f.host.open(stubOverlay('clarify', { modal: true }))
    if (onEdit) {
      onEdit(stub<Parameters<typeof onEdit>[0]>({ from: 0, to: 0, text: 'unwanted', cursor: 8, len: 0, raw: {} }))
    }
    planSheet.onKey(key('text', { text: 'unwanted' }))
    f.host.close(must(f.overlays.at(-1)))

    expect(f.element('note')?.props['text']).toBe('')
    expect(f.gw.sent('hermes-tern.plan.decide')).toEqual([])
    expect(f.send).not.toHaveBeenCalled()
  })

  it('rejects late external-editor completion after a modal preemption without any RPC', async () => {
    let finish!: (text: string) => void
    vi.mocked(editPlanExternal).mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve }))
    const f = fixture({ 'hermes-tern.plan.status': initial })
    openPlanReview(f.host)
    await paint()
    f.click('external-editor')
    expect(editPlanExternal).toHaveBeenCalledTimes(1)
    expect(editPlanExternal).toHaveBeenCalledWith(initial().plan.text)
    f.host.open(stubOverlay('approval', { modal: true }))
    finish('# Late edit from $EDITOR')
    await paint()

    expect(f.gw.sent('hermes-tern.plan.edit')).toEqual([])
    expect(f.gw.sent('hermes-tern.plan.decide')).toEqual([])
    expect(f.send).not.toHaveBeenCalled()
  })

  it('rejects stale ordinary pointer callbacks across refinement, replacement, preemption and session changes', async () => {
    const f = fixture()
    openPlanReview(f.host)
    await paint()

    const oldContinue = f.capture('approve')
    f.click('refine')
    const oldSave = f.capture('save')
    f.click('review')
    oldSave()
    expect(f.send).not.toHaveBeenCalled()

    f.host.open(stubOverlay('approval', { modal: true }))
    oldContinue()
    expect(f.send).not.toHaveBeenCalled()
    f.host.close(must(f.overlays.at(-1)))

    openPlanReview(f.host)
    await paint()
    oldContinue()
    expect(f.send).not.toHaveBeenCalled()
    const latestContinue = f.capture('approve')
    f.session.ref.live = liveSessionId('runtime-b')
    latestContinue()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.enqueue).not.toHaveBeenCalled()
  })

  it('invalidates a captured mode toggle when a fresh backend revision arrives', async () => {
    let status = initial()
    const f = fixture({
      'hermes-tern.plan.status': () => structuredClone(status),
      'hermes-tern.plan.mode': () => {
        status = { ...status, enabled: false }
        return structuredClone(status)
      }
    })
    openPlanReview(f.host)
    await paint()
    const oldMode = f.capture('mode')
    f.click('mode')
    await paint()
    oldMode()

    expect(f.gw.sent('hermes-tern.plan.mode')).toEqual([{ enabled: false, session_id: 'runtime-a' }])
    expect(f.send).not.toHaveBeenCalled()
  })

  it('renders authoritative status and sends a single exact-revision approval, not a prompt', async () => {
    const status = initial()
    const f = fixture({
      'hermes-tern.plan.status': () => structuredClone(status),
      'hermes-tern.plan.decide': params => ({ ...status, plan: { ...status.plan, decision: params['intent'] === 'approve' ? 'approved' : 'refined' } })
    })
    openPlanReview(f.host)
    await paint()

    expect(f.element('authority')?.props['text']).toContain('plan-1 · revision 3')
    expect(f.element('markdown')?.props['text']).toContain('# Implement')
    const first = f.capture('approve')
    first()
    first()
    await paint()

    expect(f.gw.sent('hermes-tern.plan.decide')).toEqual([{
      feedback: '', intent: 'approve', plan_id: 'plan-1', revision: 3, session_id: 'runtime-a'
    }])
    expect(f.gw.sent('prompt.submit')).toEqual([])
    expect(f.overlays).toHaveLength(0)
  })

  it('round-trips annotation and editing as new revisions; stale captured decisions do nothing', async () => {
    let status = initial()
    const check = (params: Record<string, unknown>) => {
      if (params['plan_id'] !== status.plan.id || params['revision'] !== status.plan.revision) {
        throw new Error('Stale plan revision')
      }
    }
    const f = fixture({
      'hermes-tern.plan.status': () => structuredClone(status),
      'hermes-tern.plan.annotate': params => {
        check(params)
        status = { ...status, plan: {
          ...status.plan, annotations: [{ section: Number(params['section']), text: String(params['text']) }],
          revision: status.plan.revision + 1
        } }

        return structuredClone(status)
      },
      'hermes-tern.plan.edit': params => {
        check(params)
        status = { ...status, plan: {
          ...status.plan, annotations: [], revision: status.plan.revision + 1, text: String(params['text'])
        } }

        return structuredClone(status)
      },
      'hermes-tern.plan.decide': () => { throw new Error('Stale approval should never reach gateway') }
    })

    openPlanReview(f.host)
    await paint()
    const stale = f.capture('approve')
    f.click('section-1')
    f.click('annotate')
    f.overlays.at(-1)?.onKey(key('text', { text: 'Add rollback test' }))
    f.click('save')
    await paint()

    expect(f.gw.sent('hermes-tern.plan.annotate')).toEqual([{
      plan_id: 'plan-1', revision: 3, section: 1, session_id: 'runtime-a', text: 'Add rollback test'
    }])
    expect(f.element('authority')?.props['text']).toContain('revision 4')
    expect(f.nodes().some(node => node.props['role'] === 'omp.plan.annotation')).toBe(true)
    stale()
    expect(f.gw.sent('hermes-tern.plan.decide')).toEqual([])

    f.click('edit-plan')
    // The dedicated editor starts with the plan; replace it without touching the prompt draft.
    for (let index = 0; index < status.plan.text.length; index++) {
      f.overlays.at(-1)?.onKey(key('backspace'))
    }
    f.overlays.at(-1)?.onKey(key('text', { text: '# Smaller\nOnly one change' }))
    f.click('save')
    await paint()
    expect(f.gw.sent('hermes-tern.plan.edit')[0]).toEqual({
      plan_id: 'plan-1', revision: 4, session_id: 'runtime-a', text: '# Smaller\nOnly one change'
    })
    expect(f.element('authority')?.props['text']).toContain('revision 5')
    expect(f.gw.sent('prompt.submit')).toEqual([])
  })

  it('drops replaced or changed-session decisions, and never displaces an active prompt', async () => {
    const f = fixture({ 'hermes-tern.plan.status': initial, 'hermes-tern.plan.decide': initial })

    openPlanReview(f.host)
    await paint()
    const stale = f.capture('approve')
    openPlanReview(f.host)
    await paint()
    stale()
    expect(f.gw.sent('hermes-tern.plan.decide')).toEqual([])
    const afterReplacement = f.capture('approve')
    f.session.ref.live = liveSessionId('runtime-b')
    afterReplacement()
    expect(f.gw.sent('hermes-tern.plan.decide')).toEqual([])

    const active = f.overlays.at(0)

    if (active) {
      f.host.close(active)
    }
    const prompt: Overlay = { key: 'approval', modal: true, node: () => node('box', { key: 'approval' }), onKey: () => true }
    f.host.open(prompt)
    openPlanReview(f.host)
    expect(f.overlays).toEqual([prompt])
    expect(f.notices).toHaveBeenCalledWith(expect.stringContaining('Close the current question'), 'warning')
  })

  it('preserves /plan with arguments as gateway generation and opens only bare /plan locally', async () => {
    const f = fixture({ 'hermes-tern.plan.status': initial })
    const cmd = must(localCommand('plan'))

    expect(await cmd.run(stub<CommandHost>(f.host), 'build the change')).toBe(false)
    expect(f.gw.sent('hermes-tern.plan.status')).toEqual([])
    await cmd.run(stub<CommandHost>(f.host), '')
    await paint()
    expect(f.element('authority')?.props['text']).toContain('revision 3')
  })
})


describe('plan gateway capability and refusal', () => {
  it('requires exactly the five attached plugin methods, never a generic or incomplete gateway', async () => {
    expect(supportsPlanMethods({ plugin_methods: Object.values(PLAN_METHODS) })).toBe(true)
    expect(supportsPlanMethods({ plugin_methods: ['plan.status'] })).toBe(false)
    expect(supportsPlanMethods({ plugin_methods: Object.values(PLAN_METHODS).slice(0, 4) })).toBe(false)
    expect(supportsPlanMethods({})).toBe(false)

    const f = fixture({ 'gateway.capabilities': () => ({ plugin_methods: [] }) })
    openPlanReview(f.host)
    await paint()

    expect(f.gw.sent('gateway.capabilities')).toEqual([{ session_id: 'runtime-a' }])
    expect(f.gw.sent('hermes-tern.plan.status')).toEqual([])
    expect(f.element('error')?.props['text']).toContain(PLAN_GATEWAY_REQUIRED)
    expect(f.element('mode')).toBeUndefined()
    expect(f.element('approve')?.props['aria']).toBe('Continue (ordinary prompt)')
    expect(f.gw.sent('hermes-tern.plan.decide')).toEqual([])
  })

  it('does not mistake a fail-closed registered status for a completed plan', async () => {
    const f = fixture({
      'hermes-tern.plan.status': () => ({
        supported: false,
        reason: 'Planning-only core turn authority is unavailable.'
      })
    })
    openPlanReview(f.host)
    await paint()

    expect(f.element('error')?.props['text']).toContain('Planning-only core turn authority')
    expect(f.element('authority')?.props['text']).toContain('Plan authority unavailable')
    expect(f.element('mode')).toBeUndefined()
    expect(f.element('edit-plan')).toBeUndefined()
    expect(f.element('approve')?.props['aria']).toBe('Continue (ordinary prompt)')
    expect(f.gw.sent('hermes-tern.plan.mode')).toEqual([])
    expect(f.gw.sent('hermes-tern.plan.decide')).toEqual([])
  })
})
