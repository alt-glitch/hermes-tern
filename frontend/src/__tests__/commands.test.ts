import { describe, expect, it, vi } from 'vitest'

import { copyToClipboard } from '../clipboard.js'
import { CONTROL_COMMANDS, type ControlHost } from '../commands/control.js'
import { type CommandHost, historyText, localCommand } from '../commands/local.js'
import { entryId } from '../core/ids.js'
import type { Entry, ToolCall } from '../model.js'

import { must, stub } from './fakes.js'

vi.mock('../clipboard.js', () => ({ copyToClipboard: vi.fn() }))

/** The slice of the command host `/agents <sub>` reaches. */
function app(paused?: boolean) {
  const agents = {
    pause: vi.fn(async (p: boolean) => {
      agents.paused = p

      return p
    }),
    paused
  }

  return { agents, transcript: { notice: vi.fn() } }
}

const agents = (a: ReturnType<typeof app>, arg: string) => must(localCommand('agents')).run(stub<CommandHost>(a), arg)

describe('/agents', () => {
  it('pauses and resumes spawns itself instead of sending them to slash.exec', async () => {
    const a = app()

    expect(await agents(a, 'pause')).not.toBe(false)
    expect(a.agents.pause).toHaveBeenCalledWith(true)
    expect(a.transcript.notice).toHaveBeenLastCalledWith(
      'Subagent spawning paused for every chat on this gateway. Running agents keep going.'
    )

    await agents(a, 'unpause')
    expect(a.agents.pause).toHaveBeenLastCalledWith(false)
    expect(a.transcript.notice).toHaveBeenLastCalledWith('Subagent spawning resumed.')
  })

  it('reports the gate this pane last set, and the usage for anything else', async () => {
    const a = app(true)

    await agents(a, 'status')
    expect(a.transcript.notice).toHaveBeenLastCalledWith('Subagent spawning: paused (gateway-wide).')

    expect(await agents(a, 'kill')).not.toBe(false)
    expect(a.transcript.notice).toHaveBeenLastCalledWith('Usage: /agents [pause|resume|status]', 'warning')
    expect(a.agents.pause).not.toHaveBeenCalled()
  })

  it('routes /bg, /background and /btw locally', () => {
    expect(localCommand('bg')?.name).toBe('bg')
    expect(localCommand('background')?.name).toBe('bg')
    expect(localCommand('btw')?.name).toBe('btw')
  })
})

function local(over: Record<string, unknown> = {}) {
  const request = vi.fn(async (_method: string, _params?: unknown) => ({ paused: false }))

  return stub<CommandHost & { request: typeof request }>({
    attachClipboardImage: vi.fn(),
    attachImagePath: vi.fn(),
    busy: null,
    control: () => ({ gw: { request }, notice: vi.fn(), sid: 'sid-1' }),
    newSession: vi.fn(),
    quit: vi.fn(),
    request,
    transcript: { notice: vi.fn() },
    ...over
  })
}

describe('local commands', () => {
  it('/q is /queue (as in Hermes), not quit', () => {
    expect(localCommand('q')?.name).toBe('queue')
    expect(localCommand('quit')?.aliases).toEqual(['exit'])
  })

  it('/clear starts a new session, as Hermes defines it; /new <title> names it', async () => {
    const a = local()

    expect(localCommand('clear')?.name).toBe('new')
    await must(localCommand('clear')).run(a, '')
    expect(a.newSession).toHaveBeenCalledWith(undefined)

    await must(localCommand('new')).run(a, ' Bug hunt ')
    expect(a.newSession).toHaveBeenLastCalledWith('Bug hunt')
  })

  it('/new waits for a running turn instead of switching away from it', async () => {
    const a = local({ busy: { label: 'Working…' } })

    await must(localCommand('reset')).run(a, '')

    expect(a.newSession).not.toHaveBeenCalled()
    expect(a.transcript.notice).toHaveBeenCalledWith(expect.stringContaining('Wait for the current turn'), 'warning')
  })

  it('/image <path> attaches that file; /paste takes no argument', async () => {
    const a = local()

    await must(localCommand('image')).run(a, './shot.png')
    expect(a.attachImagePath).toHaveBeenCalledWith('./shot.png')
    expect(a.attachClipboardImage).not.toHaveBeenCalled()

    await must(localCommand('image')).run(a, '')
    expect(a.transcript.notice).toHaveBeenCalledWith('Usage: /image <path>', 'warning')

    expect(await must(localCommand('paste')).run(a, 'x')).not.toBe(false)
    expect(a.transcript.notice).toHaveBeenCalledWith('Usage: /paste', 'warning')
  })


  it('routes the shared-gateway session verbs locally', () => {
    for (const name of ['undo', 'retry', 'compress', 'compact', 'branch', 'fork', 'bg', 'background', 'btw', 'save', 'reload', 'reload-skills', 'rollback']) {
      expect(localCommand(name), name).toBeDefined()
    }
  })

  it('a bare /queue reports how many prompts wait', () => {
    const notice = vi.fn()

    must(CONTROL_COMMANDS.find(c => c.name === 'queue')).run(stub<ControlHost>({ notice, queued: 2 }), '')

    expect(notice).toHaveBeenCalledWith('2 queued messages')
  })
})

const turn = (id: string, text: string, tools = 0): Entry => ({
  blocks: [
    ...Array.from({ length: tools }, (_, i) => ({ call: stub<ToolCall>({}), id: entryId(`${id}c${i}`), kind: 'tool' as const })),
    ...(text ? [{ id: entryId(`${id}x`), kind: 'text' as const, text }] : [])
  ],
  end: { status: 'done' },
  id: entryId(id),
  kind: 'turn',
  rev: 0,
  startedAt: 0
})

const user = (id: string, text: string): Entry => ({ at: 0, id: entryId(id), kind: 'user', text })

describe('/copy and /history', () => {
  const entries = [user('u1', 'hi'), turn('t1', 'first answer'), user('u2', 'more'), turn('t2', '', 2), turn('t3', 'last answer')]
  const withTranscript = () => {
    const transcript = { entries, notice: vi.fn(), panel: vi.fn() }

    return Object.assign(local({ transcript }), { transcript })
  }

  it('/copy takes the last answer, /copy n the nth, clamped to the last', async () => {
    const a = withTranscript()

    await must(localCommand('copy')).run(a, '')
    expect(copyToClipboard).toHaveBeenLastCalledWith('last answer')

    await must(localCommand('copy')).run(a, '1')
    expect(copyToClipboard).toHaveBeenLastCalledWith('first answer')
    expect(a.transcript.notice).toHaveBeenLastCalledWith('Copied answer 1 (12 characters).')

    await must(localCommand('copy')).run(a, '9')
    expect(copyToClipboard).toHaveBeenLastCalledWith('last answer')

    await must(localCommand('copy')).run(a, 'x')
    expect(a.transcript.notice).toHaveBeenLastCalledWith('Usage: /copy [n] (n counts answers from the first)', 'warning')
  })

  it('/history shows the prompts and answers, a tool-only turn by its calls, clipped to [chars]', () => {
    expect(historyText(entries, '')).toBe(
      ['**You #1**\nhi', '**Hermes #2**\nfirst answer', '**You #3**\nmore', '**Hermes #4**\n(2 tool calls)', '**Hermes #5**\nlast answer'].join('\n\n')
    )
    expect(historyText([user('u', 'x'.repeat(100))], '80')).toBe(`**You #1**\n${'x'.repeat(80)}…`)
    expect(historyText([], '')).toBe('No conversation yet.')
  })

  it('/history is a panel in the transcript', async () => {
    const a = withTranscript()

    await must(localCommand('history')).run(a, '')
    expect(a.transcript.panel).toHaveBeenCalledWith('/history', expect.stringContaining('last answer'))
  })
})
