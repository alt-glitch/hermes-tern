import { describe, expect, it, vi } from 'vitest'

import type { App } from '../app.js'
import { localCommand } from '../commands.js'

/** The slice of App `/agents <sub>` reaches. */
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

const agents = (a: ReturnType<typeof app>, arg: string) => localCommand('agents')!.run(a as unknown as App, arg)

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
