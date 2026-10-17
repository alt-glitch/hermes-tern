import { describe, expect, it, vi } from 'vitest'

import type { App } from '../app.js'
import { localCommand } from '../commands.js'
import { CONTROL_COMMANDS, type ControlHost } from '../controlCommands.js'

function app(over: Record<string, unknown> = {}) {
  const request = vi.fn(async (_method: string, _params?: unknown) => ({ paused: false }))

  return {
    attachClipboardImage: vi.fn(),
    attachImagePath: vi.fn(),
    busy: null,
    control: () => ({ gw: { request }, notice: vi.fn(), sid: 'sid-1' }),
    newSession: vi.fn(),
    quit: vi.fn(),
    request,
    transcript: { notice: vi.fn() },
    ...over
  } as unknown as App & { request: typeof request }
}

describe('local commands', () => {
  it('/q is /queue (as in Hermes), not quit', () => {
    expect(localCommand('q')?.name).toBe('queue')
    expect(localCommand('quit')?.aliases).toEqual(['exit'])
  })

  it('/clear starts a new session, as Hermes defines it; /new <title> names it', async () => {
    const a = app()

    expect(localCommand('clear')?.name).toBe('new')
    await localCommand('clear')!.run(a, '')
    expect(a.newSession).toHaveBeenCalledWith(undefined)

    await localCommand('new')!.run(a, ' Bug hunt ')
    expect(a.newSession).toHaveBeenLastCalledWith('Bug hunt')
  })

  it('/new waits for a running turn instead of switching away from it', async () => {
    const a = app({ busy: { label: 'Working…' } })

    await localCommand('reset')!.run(a, '')

    expect(a.newSession).not.toHaveBeenCalled()
    expect(a.transcript.notice).toHaveBeenCalledWith(expect.stringContaining('Wait for the current turn'), 'warning')
  })

  it('/image <path> attaches that file; /paste takes no argument', async () => {
    const a = app()

    await localCommand('image')!.run(a, './shot.png')
    expect(a.attachImagePath).toHaveBeenCalledWith('./shot.png')
    expect(a.attachClipboardImage).not.toHaveBeenCalled()

    await localCommand('image')!.run(a, '')
    expect(a.transcript.notice).toHaveBeenCalledWith('Usage: /image <path>', 'warning')

    expect(await localCommand('paste')!.run(a, 'x')).not.toBe(false)
    expect(a.transcript.notice).toHaveBeenCalledWith('Usage: /paste', 'warning')
  })

  it('/agents pause calls delegation.pause instead of slash.exec', async () => {
    const a = app()

    expect(await localCommand('agents')!.run(a, 'resume')).not.toBe(false)
    expect(a.request).toHaveBeenCalledWith('delegation.pause', { paused: false, session_id: 'sid-1' })
  })

  it('routes the shared-gateway session verbs locally', () => {
    for (const name of ['undo', 'retry', 'compress', 'compact', 'branch', 'fork', 'bg', 'background', 'btw', 'save', 'reload', 'reload-skills', 'rollback']) {
      expect(localCommand(name), name).toBeDefined()
    }
  })

  it('a bare /queue reports how many prompts wait', () => {
    const notice = vi.fn()

    CONTROL_COMMANDS.find(c => c.name === 'queue')!.run({ notice, queued: 2 } as unknown as ControlHost, '')

    expect(notice).toHaveBeenCalledWith('2 queued messages')
  })
})
