import { describe, expect, it, vi } from 'vitest'

import { SESSION_COMMANDS, type SessionHost } from '../commands/session.js'
import { liveSessionId } from '../core/ids.js'
import { promptRows, promptText, rowBefore, undoRewind, userTurns } from '../hermes/rewind.js'
import type { Overlay } from '../overlays/overlay.js'
import { openRewind, type RewindHost } from '../overlays/rewind.js'

import { FakeGateway, key, must, tree } from './fakes.js'

/** Three prompts, a compaction carrier and a notice row; rows 1-9. */
const MESSAGES = [
  { content: 'first', role: 'user', row_id: 1 },
  { content: 'one', role: 'assistant', row_id: 2 },
  { content: 'fix the bug', role: 'user', row_id: 3 },
  { content: '', role: 'assistant', row_id: 4, tool_calls: [{ id: 'c1' }] },
  { content: 'ran', role: 'tool', row_id: 5 },
  { content: 'fixed it', role: 'assistant', row_id: 6 },
  { content: '[CONTEXT SUMMARY]: earlier work', role: 'user', row_id: 7 },
  { content: [{ text: 'and this', type: 'text' }, { image_url: 'x', type: 'image_url' }], role: 'user', row_id: 8 },
  { content: 'note', display_kind: 'notice', role: 'user', row_id: 9 }
]

describe('rewind targets', () => {
  it('/undo N names the Nth newest human prompt, clamped to the oldest', () => {
    expect(userTurns({ messages: MESSAGES }).map(t => t.row_id)).toEqual([1, 3, 8])
    expect(undoRewind(1)({ messages: MESSAGES })).toEqual({ target_message_id: 8 })
    expect(undoRewind(2)({ messages: MESSAGES })).toEqual({ target_message_id: 3 })
    expect(undoRewind(9)({ messages: MESSAGES })).toEqual({ target_message_id: 1 })
    expect(undoRewind(2)({ messages: [] })).toBeNull()
  })

  it("a branch before a prompt ends at the row before it; the first prompt's has none", () => {
    expect(rowBefore({ messages: MESSAGES }, 3)).toBe(2)
    expect(rowBefore({ messages: MESSAGES }, 8)).toBe(7)
    expect(rowBefore({ messages: MESSAGES }, 1)).toBeNull()
  })

  it("lists each prompt with its last reply and the prompts after it; an image prompt's text stays", () => {
    expect(promptRows({ messages: MESSAGES })).toEqual([
      { after: 2, media: false, reply: 'one', row: 1, steer: false, text: 'first' },
      { after: 1, media: false, reply: 'fixed it', row: 3, steer: false, text: 'fix the bug' },
      { after: 0, media: true, reply: '', row: 8, steer: false, text: 'and this' }
    ])
    expect(promptText({ unknown: true })).toEqual({ media: true, text: '' })
  })
})

function sessionHost(gw: FakeGateway, over: Partial<SessionHost> = {}): SessionHost {
  return {
    busy: false,
    canonical: true,
    compressing: vi.fn(),
    draft: vi.fn(),
    enqueue: vi.fn(),
    gw: gw.client,
    notice: vi.fn(),
    open: vi.fn(async () => true),
    panel: vi.fn(),
    queued: 0,
    reload: vi.fn(async () => undefined),
    send: vi.fn(),
    sid: liveSessionId('sid-1'),
    stale: () => false,
    submit: vi.fn(),
    ...over
  }
}

/** Lets the sheet's reads and writes, and their awaits, run. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

const snapshot = (messages: unknown[] = MESSAGES) => ({ execution_generation: 7, revision: 3, stored_messages: messages })

/** The sheet on a session whose snapshot is `MESSAGES`; `after` is the host the view has once it moved. */
async function sheet(replies: Record<string, () => unknown> = {}, over: Partial<SessionHost> = {}) {
  const gw = new FakeGateway({ replies: { 'session.resume': () => snapshot(), ...replies } })
  const session = sessionHost(gw, over)
  const after = sessionHost(gw)
  const opened: Overlay[] = []
  const control = vi.fn<RewindHost['control']>(() => session)
  const host = {
    changed: vi.fn(),
    close: vi.fn((o: Overlay) => void opened.splice(opened.indexOf(o), 1)),
    control,
    open: (o: Overlay) => void opened.push(o)
  } satisfies RewindHost

  openRewind(host)
  await settle()
  // Later control() calls are the view after a branch moved it.
  control.mockImplementation(() => after)

  return { after, gw, host, opened, session }
}

const picker = (o: Overlay | undefined) => tree(must(o, 'the sheet').node('layer.rewind'))

describe('the rewind sheet', () => {
  it('lists the prompts oldest first with the newest picked', async () => {
    const { opened } = await sheet()
    const p = must(picker(opened[0]).p)

    expect(p['order']).toEqual(['1', '3', '8'])
    expect(p['selected']).toBe('8')
    expect(p['layout']).toBe('timeline')
  })

  it('rewinds after a confirm, at the revision it re-read, and puts the prompt back in the composer', async () => {
    const { gw, opened, session } = await sheet({ 'session.mutate': () => ({ rewound_count: 4, target_message: { content: 'fix the bug' } }) })
    const sheetNode = must(opened[0])

    sheetNode.onKey(key('up'))
    sheetNode.onKey(key('enter'))
    // Enter asks first: nothing is written yet.
    expect(gw.sent('session.mutate')).toEqual([])
    expect(must(picker(sheetNode).p)['confirm']).toMatchObject({ label: 'Rewind' })

    sheetNode.onKey(key('enter'))
    await settle()

    expect(gw.sent('session.mutate')).toEqual([
      expect.objectContaining({ expected_generation: 7, expected_revision: 3, operation: 'rewind', payload: { target_message_id: 3 }, session_id: 'sid-1' })
    ])
    expect(session.reload).toHaveBeenCalled()
    expect(session.draft).toHaveBeenCalledWith('fix the bug')
    expect(session.notice).toHaveBeenCalledWith('Rewound 4 messages. The prompt is back in the composer.')
    expect(opened).toEqual([])
  })

  it('writes nothing when the picked prompt left the session since the sheet read it', async () => {
    let reads = 0
    const { gw, opened, session } = await sheet({ 'session.resume': () => snapshot(reads++ ? MESSAGES.slice(0, 2) : MESSAGES) })
    const sheetNode = must(opened[0])

    sheetNode.onKey(key('enter'))
    sheetNode.onKey(key('y'))
    await settle()

    expect(gw.sent('session.mutate')).toEqual([])
    expect(session.notice).toHaveBeenCalledWith('That prompt is no longer in this session: nothing was rewound.', 'warning')
  })

  it('B branches before the prompt, moves to the branch, and drafts the prompt there', async () => {
    const { after, gw, opened, session } = await sheet({ 'session.mutate': () => ({ branched_session_id: 'child-1' }) })
    const sheetNode = must(opened[0])

    sheetNode.onKey(key('up'))
    sheetNode.onKey(key('b'))
    await settle()

    expect(gw.sent('session.mutate')).toEqual([expect.objectContaining({ operation: 'branch', payload: { through_message_id: 2 } })])
    expect(session.open).toHaveBeenCalledWith('child-1')
    expect(session.draft).not.toHaveBeenCalled()
    expect(after.draft).toHaveBeenCalledWith('fix the bug')
  })

  it('has no branch before the first prompt', async () => {
    const { gw, opened } = await sheet()
    const sheetNode = must(opened[0])

    sheetNode.onKey(key('up'))
    sheetNode.onKey(key('up'))
    sheetNode.onKey(key('b'))
    await settle()

    expect(gw.sent('session.mutate')).toEqual([])
    expect(must(picker(sheetNode).p)['actions']).toContainEqual(expect.objectContaining({ disabled: expect.stringContaining('first prompt'), id: 'branch' }))
  })

  it('does not open while a turn runs or prompts wait', () => {
    const gw = new FakeGateway()
    const session = sessionHost(gw, { queued: 1 })
    const open = vi.fn()

    openRewind({ changed: vi.fn(), close: vi.fn(), control: () => session, open })

    expect(open).not.toHaveBeenCalled()
    expect(gw.calls).toEqual([])
    expect(session.notice).toHaveBeenCalledWith(expect.stringContaining('before rewinding'), 'warning')
  })
})

describe('/undo N', () => {
  const run = (host: SessionHost, arg: string) => must(SESSION_COMMANDS.find(c => c.name === 'undo')).run(host, arg)

  it('rewinds to before the Nth newest prompt', async () => {
    const gw = new FakeGateway({ replies: { 'session.mutate': () => ({ rewound_count: 6 }), 'session.resume': () => snapshot() } })
    const host = sessionHost(gw)

    await run(host, '2')

    expect(gw.sent('session.mutate')).toEqual([expect.objectContaining({ operation: 'rewind', payload: { target_message_id: 3 } })])
    expect(host.notice).toHaveBeenCalledWith('Undid 6 messages.')
  })

  it('refuses a count that is not a whole number above zero, before it reads anything', async () => {
    const gw = new FakeGateway()
    const host = sessionHost(gw)

    await run(host, '0')
    await run(host, 'two')

    expect(gw.calls).toEqual([])
    expect(host.notice).toHaveBeenCalledWith('Usage: /undo [N] (N counts prompts back from the newest)', 'warning')
  })
})
