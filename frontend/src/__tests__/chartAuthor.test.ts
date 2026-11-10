// The chart author on the plugin route: the RPC call, its reply event, and the registry's one retry
// on an answer the Python half refused (processes/widgets/author.ts, charts.py).

import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import type { BackgroundProcess } from '../model.js'
import { AUTHOR_EVENT, AUTHOR_METHOD, gatewayAuthor, RejectedAnswer, renderPrompt, SYSTEM_PROMPT } from '../processes/widgets/author.js'
import { Charts } from '../processes/widgets/registry.js'
import type { Spec } from '../processes/widgets/spec.js'

const LOAD: Spec = {
  blocks: [{ better: 'higher', field: 'rps', kind: 'spark', label: 'req/s', unit: 'req/s' }],
  rules: [{ from: 'out', match: '^req \\d+ rps=(?P<rps>[\\d.]+)' }],
  title: 'load test · rps'
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `req ${i + 1} rps=${51 + i}`).join('\n') + '\n'

const proc = (output: string): BackgroundProcess => ({
  command: 'bench --goal 60',
  id: 'proc_1',
  lastLine: '',
  output,
  startedAt: 0,
  state: { status: 'running' }
})

describe('the gateway author', () => {
  /** A gateway whose `charts.author` call answers at once and sends `reply` (by job) as the session's event; `null` sends none. */
  const gateway = (reply: ((job: string) => Record<string, unknown>) | null, fail?: { code?: number; message: string }) => {
    const calls: { method: string; params: Record<string, unknown> }[] = []
    const gw = Object.assign(new EventEmitter(), {
      calls,
      async request(method: string, params: Record<string, unknown> = {}) {
        gw.calls.push({ method, params })

        if (fail) {
          throw Object.assign(new Error(fail.message), { code: fail.code })
        }

        const job = String(params['job'])

        if (reply) {
          setTimeout(() => gw.emit('event', { payload: { job: 'another', answer: { skip: 'not mine' } }, type: AUTHOR_EVENT }))
          setTimeout(() => gw.emit('event', { payload: reply(job), type: AUTHOR_EVENT }))
        }

        return { job }
      }
    })

    return gw
  }
  const request = { command: 'bench --goal 60', id: 'proc_1', sources: [] }
  const signal = () => new AbortController().signal

  it('sends the prompt and the session, and answers with the event of its job', async () => {
    const gw = gateway(job => ({ answer: LOAD, job }))

    expect(await gatewayAuthor(gw, () => 'live-1')(request, signal())).toEqual(LOAD)
    const [call] = gw.calls
    expect(call?.method).toBe(AUTHOR_METHOD)
    expect(call?.params).toMatchObject({ session_id: 'live-1', system: SYSTEM_PROMPT })
    expect(call?.params['user']).toContain('bench --goal 60')
  })

  it('hands on a rejected answer, no model, and an error', async () => {
    const rejected = gateway(job => ({ job, rejected: { answer: 'Sure!', errors: ['the answer is not one JSON object'] } }))
    expect(await gatewayAuthor(rejected, () => 'live-1')(request, signal())).toEqual(new RejectedAnswer('Sure!', ['the answer is not one JSON object']))
    expect(await gatewayAuthor(gateway(job => ({ job, unavailable: true })), () => 'live-1')(request, signal())).toBeUndefined()
    await expect(gatewayAuthor(gateway(job => ({ error: 'TimeoutError: slow', job })), () => 'live-1')(request, signal())).rejects.toThrow('slow')
  })

  it('reads a gateway without the method as no model, and fails without a session or on another error', async () => {
    expect(await gatewayAuthor(gateway(null, { code: -32601, message: 'unknown method' }), () => 'live-1')(request, signal())).toBeUndefined()
    await expect(gatewayAuthor(gateway(null, { code: 4001, message: 'plugin_rpc_failed' }), () => 'live-1')(request, signal())).rejects.toThrow('plugin_rpc_failed')
    await expect(gatewayAuthor(gateway(job => ({ answer: LOAD, job })), () => null)(request, signal())).rejects.toThrow('no session')
  })

  it('stops waiting when the request is aborted before the call is answered', async () => {
    const gw = Object.assign(new EventEmitter(), { request: () => new Promise<never>(() => undefined) })
    const controller = new AbortController()
    const asked = gatewayAuthor(gw, () => 'live-1')(request, controller.signal)

    controller.abort(new Error('process ended'))
    await expect(asked).rejects.toThrow('process ended')
  })

  it('stops waiting when the request is aborted', async () => {
    const controller = new AbortController()
    const asked = gatewayAuthor(gateway(null), () => 'live-1')(request, controller.signal)

    controller.abort(new Error('process ended'))
    await expect(asked).rejects.toThrow('process ended')
  })
})

describe('a rejected answer', () => {
  it('is asked again once with its text and reasons', async () => {
    const requests: (string | undefined)[] = []
    const charts = new Charts(() => undefined, {
      author: async r => {
        requests.push(r.rejected ? renderPrompt(r) : undefined)

        return requests.length === 1 ? new RejectedAnswer('Sure! Here is a chart.', ['the answer is not one JSON object']) : LOAD
      },
      now: () => 20_000
    })
    const p = proc(lines(5))

    charts.view(p)
    await new Promise(r => setTimeout(r, 0))
    expect(requests).toHaveLength(2)
    expect(requests[1]).toContain('Sure! Here is a chart.')
    expect(requests[1]).toContain('- the answer is not one JSON object')
    expect(charts.view(p)?.state).toBe('live')
  })

  it('leaves the fence out when the text was not kept', () => {
    const prompt = renderPrompt({ command: 'x', id: 'p', rejected: { answer: '', errors: ["'rules' is required"] }, sources: [] })

    expect(prompt).toContain("Your previous answer was rejected:\nProblems:\n- 'rules' is required")
  })
})
