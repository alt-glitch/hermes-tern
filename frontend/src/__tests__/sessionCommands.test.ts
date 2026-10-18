import { describe, expect, it, vi } from 'vitest'

import { mutateSession } from '../hermes/mutate.js'
import { lastTurnRewind, retryText, retryTurnRewind } from '../hermes/rewind.js'
import { compressReport, SESSION_COMMANDS, type SessionHost } from '../sessionCommands.js'

const MESSAGES = [
  { content: 'first', role: 'user', row_id: 1 },
  { content: 'one', role: 'assistant', row_id: 2 },
  { content: 'fix the bug', role: 'user', row_id: 3 },
  { content: 'done', role: 'assistant', row_id: 4 },
  { content: '[CONTEXT SUMMARY]: earlier work', role: 'user', row_id: 5 },
  { content: 'note', display_kind: 'notice', role: 'user', row_id: 6 }
]

const run = (name: string, host: SessionHost, arg = '') =>
  SESSION_COMMANDS.find(c => c.name === name || c.aliases?.includes(name))!.run(host, arg)

function host(over: Partial<SessionHost> = {}, replies: Record<string, unknown> = {}) {
  const request = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
    const r = replies[method]

    if (r instanceof Error) {
      throw r
    }

    return method === 'session.resume' ? { execution_generation: 7, messages: MESSAGES, revision: 3, ...(r as object) } : r
  })

  const h = {
    busy: false,
    canonical: true,
    enqueue: vi.fn(),
    gw: { request } as unknown as SessionHost['gw'],
    notice: vi.fn(),
    open: vi.fn(async () => true),
    panel: vi.fn(),
    queued: 0,
    reload: vi.fn(async () => undefined),
    send: vi.fn(),
    sid: 'sid-1',
    stale: () => false,
    submit: vi.fn(),
    ...over
  }

  return { h, request }
}

const mutation = (request: ReturnType<typeof host>['request']) =>
  request.mock.calls.find(([method]) => method === 'session.mutate')?.[1] as Record<string, unknown> | undefined

describe('rewind targets', () => {
  it('names the newest human user turn, skipping compaction carriers and display rows', () => {
    expect(lastTurnRewind({ messages: MESSAGES })).toEqual({ target_message_id: 3 })
    expect(lastTurnRewind({ messages: [] })).toBeNull()
    // The stored rows win over a display projection.
    expect(lastTurnRewind({ messages: MESSAGES, stored_messages: [{ content: 'x', role: 'user', row_id: 9 }] })).toEqual({
      target_message_id: 9
    })
  })

  it('refuses to retry a turn that carries media, before anything is rewound', () => {
    expect(retryText([{ text: 'hi', type: 'text' }])).toBe('hi')
    expect(retryText([{ type: 'image_url', image_url: 'x' }])).toBeNull()
    expect(() => retryTurnRewind({ messages: [{ content: [{ type: 'image' }], role: 'user', row_id: 1 }] })).toThrow(
      /media/
    )
  })
})

describe('session.mutate', () => {
  it('fences a rename by revision only, and a payload function sees the snapshot', async () => {
    const { request } = host({}, { 'session.mutate': { title: 'Bug hunt' } })

    await mutateSession({ request } as never, 'sid-1', 'rename', { title: 'Bug hunt' })
    expect(mutation(request)).toMatchObject({ expected_revision: 3, operation: 'rename', payload: { title: 'Bug hunt' } })
    expect(mutation(request)).not.toHaveProperty('expected_generation')

    const seen = vi.fn(() => null)
    expect(await mutateSession({ request } as never, 'sid-1', 'rewind', seen)).toBeNull()
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ revision: 3 }))
  })
})

describe('session commands', () => {
  it('/undo rewinds the newest user turn at the current revision and reloads the transcript', async () => {
    const { h, request } = host({}, { 'session.mutate': { rewound_count: 2 } })

    await run('undo', h)

    expect(mutation(request)).toMatchObject({
      expected_generation: 7,
      expected_revision: 3,
      operation: 'rewind',
      payload: { target_message_id: 3 },
      session_id: 'sid-1'
    })
    expect(h.reload).toHaveBeenCalled()
    expect(h.notice).toHaveBeenCalledWith('Undid 2 messages.')
  })

  it('/undo with no user turn writes nothing', async () => {
    const { h, request } = host({}, { 'session.resume': { messages: [] } })

    await run('undo', h)

    expect(mutation(request)).toBeUndefined()
    expect(h.notice).toHaveBeenCalledWith('Nothing to undo.')
  })

  it('/retry rewinds, then resends the rewound turn its own text', async () => {
    const { h } = host({}, { 'session.mutate': { rewound_count: 2, target_message: { content: 'fix the bug' } } })

    await run('retry', h)

    expect(h.reload).toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledWith('fix the bug')
  })

  it('leaves rewind, compress and branch to slash.exec on a private gateway', async () => {
    const { h, request } = host({ canonical: false })

    for (const name of ['undo', 'retry', 'compact', 'fork']) {
      expect(await run(name, h)).toBe(false)
    }

    expect(request).not.toHaveBeenCalled()
  })

  it('/compress sends the raw argument as focus, reloads, and prints the report', async () => {
    const summary = { headline: 'Compressed 12 messages', token_line: '40k → 8k tokens' }
    const { h, request } = host({}, { 'session.mutate': { status: 'applied', summary } })

    await run('compress', h, 'here 3')

    expect(mutation(request)).toMatchObject({ operation: 'compress', payload: { focus: 'here 3' } })
    expect(h.reload).toHaveBeenCalled()
    expect(h.notice).toHaveBeenCalledWith('✓ Compressed 12 messages\n  40k → 8k tokens')
  })

  it('/compress --preview and a no-op compression leave the transcript alone', async () => {
    const preview = host({}, { 'session.mutate': { lines: ['would remove 4'], status: 'preview' } })
    await run('compress', preview.h, '--preview')
    expect(preview.h.notice).toHaveBeenCalledWith('would remove 4')
    expect(preview.h.reload).not.toHaveBeenCalled()

    const noop = host({}, { 'session.mutate': { status: 'noop', summary: { headline: 'No changes', noop: true } } })
    await run('compact', noop.h)
    expect(mutation(noop.request)).toMatchObject({ payload: {} })
    expect(noop.h.reload).not.toHaveBeenCalled()
    expect(noop.h.notice).toHaveBeenCalledWith('No changes')
    expect(compressReport(undefined)).toBe('✓ Transcript compressed.')
  })

  it('/branch opens the branched session and names it', async () => {
    const { h, request } = host({}, { 'session.info': { title: 'Bug hunt #2' }, 'session.mutate': { branched_session_id: 'child' } })

    await run('fork', h, 'try B')

    expect(mutation(request)).toMatchObject({ operation: 'branch', payload: { title: 'try B' } })
    expect(h.open).toHaveBeenCalledWith('child')
    expect(h.notice).toHaveBeenCalledWith('Branched → Bug hunt #2')
  })

  it('reports a refusal as the command failing', async () => {
    const { h } = host({}, { 'session.mutate': new Error('session_busy') })

    await run('undo', h)

    expect(h.notice).toHaveBeenCalledWith('/undo failed: session_busy', 'error')
  })


  it('/save, /reload and /reload-skills call their RPCs with the session', async () => {
    const { h, request } = host(
      {},
      { 'reload.env': { updated: 1 }, 'session.save': { file: '/tmp/a.json' }, 'skills.reload': { output: 'Added: x' } }
    )

    await run('save', h)
    await run('reload', h)
    await run('reload_skills', h)

    expect(request).toHaveBeenCalledWith('session.save', { session_id: 'sid-1' })
    expect(request).toHaveBeenCalledWith('reload.env', { session_id: 'sid-1' })
    expect(request).toHaveBeenCalledWith('skills.reload', { session_id: 'sid-1' })
    expect(h.notice).toHaveBeenCalledWith('Conversation saved to: /tmp/a.json', 'info')
    expect(h.notice).toHaveBeenCalledWith('Reloaded .env (1 var updated).')
    expect(h.panel).toHaveBeenCalledWith('Reload Skills', 'Added: x')
  })

  it('/reload-mcp calls reload.mcp, confirmed, and names the servers that did not connect', async () => {
    const { h, request } = host(
      {},
      { 'reload.mcp': { message: 'MCP servers reconciled (added: argus)', session: 'applied', status: 'reloaded', unavailable: ['linear'] } }
    )

    await run('reload_mcp', h)

    expect(request).toHaveBeenCalledWith('reload.mcp', { confirm: true, session_id: 'sid-1' })
    expect(h.panel).toHaveBeenCalledWith('Reload MCP', 'MCP servers reconciled (added: argus)')
    expect(h.notice).toHaveBeenCalledWith('Did not connect: linear.', 'warning')
  })

  it('/reload-mcp on a private gateway is left to slash.exec', async () => {
    const { h, request } = host({ canonical: false })

    expect(await run('reload-mcp', h)).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })

  it('/rollback lists, diffs and restores checkpoints', async () => {
    const { h, request } = host(
      {},
      {
        'rollback.diff': { diff: '-a\n+b', stat: '1 file changed' },
        'rollback.list': { checkpoints: [{ hash: 'abcdef1234567', message: 'before edit', timestamp: 't1' }], enabled: true },
        'rollback.restore': { history_removed: 2, message: 'restored to abcdef1', success: true }
      }
    )

    await run('rollback', h)
    expect(h.panel).toHaveBeenCalledWith('Rollback checkpoints', '1. abcdef1234  t1 · before edit')

    await run('rollback', h, 'diff 1')
    expect(request).toHaveBeenCalledWith('rollback.diff', { hash: '1', session_id: 'sid-1' })
    expect(h.panel).toHaveBeenCalledWith('Rollback diff', '1 file changed\n\n-a\n+b')

    await run('rollback', h, '1 src/a.ts')
    expect(request).toHaveBeenCalledWith('rollback.restore', { file_path: 'src/a.ts', hash: '1', session_id: 'sid-1' })
    expect(h.reload).toHaveBeenCalled()
    expect(h.notice).toHaveBeenCalledWith('Rollback restored src/a.ts: restored to abcdef1')
  })

})
