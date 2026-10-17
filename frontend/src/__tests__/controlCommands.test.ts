import { describe, expect, it, vi } from 'vitest'

import { CONTROL_COMMANDS, type ControlHost, steerTurn } from '../controlCommands.js'

const run = (name: string, host: ControlHost, arg = '') => CONTROL_COMMANDS.find(c => c.name === name)!.run(host, arg)

function host(over: Partial<ControlHost> = {}, replies: Record<string, unknown> = {}) {
  const request = vi.fn(async (method: string) => {
    const r = replies[method]

    if (r instanceof Error) {
      throw r
    }

    return method === 'session.resume' ? { execution_generation: 7, revision: 3 } : r
  })

  const h = {
    busy: true,
    enqueue: vi.fn(),
    gw: { request } as unknown as ControlHost['gw'],
    notice: vi.fn(),
    sid: 'sid-1',
    submit: vi.fn(),
    ...over
  }

  return { h, request }
}

describe('control commands', () => {
  it('steers the active turn at its current execution generation', async () => {
    const { h, request } = host({}, { 'session.steer': { status: 'queued' } })

    await run('steer', h, 'focus on tests')

    expect(request).toHaveBeenCalledWith('session.steer', {
      execution_generation: 7,
      session_id: 'sid-1',
      text: 'focus on tests'
    })
    expect(h.enqueue).not.toHaveBeenCalled()
  })

  it('queues a steer when no turn is running, without any RPC', async () => {
    const { h, request } = host({ busy: false })

    await run('steer', h, 'later')

    expect(h.enqueue).toHaveBeenCalledWith('later')
    expect(request).not.toHaveBeenCalled()
  })

  it('queues a steer the gateway rejected or that went stale', async () => {
    const rejected = host({}, { 'session.steer': { status: 'rejected' } })
    await run('steer', rejected.h, 'a')
    expect(rejected.h.enqueue).toHaveBeenCalledWith('a')

    const stale = host({}, { 'session.steer': new Error('stale_generation') })
    await run('steer', stale.h, 'b')
    expect(stale.h.enqueue).toHaveBeenCalledWith('b')
  })

  it('/stop interrupts with the execution generation', async () => {
    const { h, request } = host({}, { 'process.stop': { killed: 2 } })

    await run('stop', h)

    expect(request).toHaveBeenCalledWith('session.interrupt', { execution_generation: 7, session_id: 'sid-1' })
    expect(request).toHaveBeenCalledWith('process.stop', { session_id: 'sid-1' })
  })

  it('/tools enable warns without touching the gateway', async () => {
    const { h, request } = host()

    await run('tools', h, 'enable web')

    expect(h.notice).toHaveBeenCalledWith(expect.stringContaining('/tools enable is not available'), 'warning')
    expect(request).not.toHaveBeenCalled()
  })

  it('/tools lists the owner catalog from tools.show', async () => {
    const { h, request } = host(
      {},
      { 'tools.show': { sections: [{ name: 'web', tools: [{ description: '', name: 'web_search' }] }], total: 1 } }
    )

    await run('tools', h)

    expect(request).toHaveBeenCalledWith('tools.show', { session_id: 'sid-1' })
    expect(h.notice).toHaveBeenCalledWith('[web] web_search\nTotal: 1 tools')
  })
})

describe('steerTurn', () => {
  const gw = (steer: unknown) =>
    ({
      request: vi.fn(async (m: string) => {
        if (m === 'session.resume') {
          return { execution_generation: 4 }
        }

        if (steer instanceof Error) {
          throw steer
        }

        return steer
      })
    }) as unknown as ControlHost['gw']

  it('lands at the current generation when the gateway queues it', async () => {
    const g = gw({ status: 'queued' })

    expect(await steerTurn(g, 's', 'hi')).toEqual({ ok: true })
    expect(g.request).toHaveBeenCalledWith('session.steer', { execution_generation: 4, session_id: 's', text: 'hi' })
  })

  it('reports a rejection or a stale generation without an error', async () => {
    expect(await steerTurn(gw({ status: 'rejected' }), 's', 'hi')).toEqual({ ok: false })
    expect(await steerTurn(gw(new Error('stale_generation')), 's', 'hi')).toEqual({ ok: false })
  })

  it('carries other failures as an error', async () => {
    expect(await steerTurn(gw(new Error('execution_not_ready')), 's', 'hi')).toEqual({
      error: 'execution_not_ready',
      ok: false
    })
  })
})
