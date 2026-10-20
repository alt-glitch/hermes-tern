import { describe, expect, expectTypeOf, it } from 'vitest'
import * as z from 'zod/mini'

import { foldEntry } from '../processes/store.js'
import { type ResultOf, rpc, rpcParsed } from '../wire/rpc.js'
import { pendingRows, processList, type ProcessRow, usageCounters } from '../wire/schemas.js'

import { FakeGateway } from './fakes.js'

const NOW = 1_800_000_000_000

/** A gateway that answers `method` with `answer`; a thrown error rejects the request. */
const gateway = (method: string, answer: () => unknown) => new FakeGateway({ replies: { [method]: answer } })

/** The one row a list holds. */
function only(rows: ProcessRow[]): ProcessRow {
  const [row] = rows

  if (!row || rows.length !== 1) {
    throw new Error(`expected one row, got ${rows.length}`)
  }

  return row
}

describe('rpc', () => {
  it('sends the method and the params as they are, and answers with the reply', async () => {
    const gw = gateway('session.steer', () => ({ status: 'queued', text: 'go left' }))
    const params = { execution_generation: 4, session_id: 's1', text: 'go left' }

    const r = await rpc(gw.client, 'session.steer', params)

    expect(gw.calls).toEqual([{ method: 'session.steer', params }])
    expect(gw.calls[0]?.params).toBe(params)
    expect(r).toEqual({ status: 'queued', text: 'go left' })
  })

  it('types a reshaped result as either gateway gives it', () => {
    expectTypeOf<ResultOf<'session.resume'>>().toHaveProperty('session_id').toEqualTypeOf<string>()
    expectTypeOf<Extract<ResultOf<'prompt.submit'>, { admission_id: string }>>().toHaveProperty('input_id')
    expectTypeOf<ResultOf<'subagent.list'>>().toHaveProperty('subagents')
  })

  it('passes a refusal on', async () => {
    const gw = gateway('session.save', () => {
      throw new Error('session_not_found')
    })

    await expect(rpc(gw.client, 'session.save', { session_id: 's1' })).rejects.toThrow('session_not_found')
  })
})

describe('rpcParsed', () => {
  const answer = z.object({ count: z.number() })

  it('answers with what the schema reads', async () => {
    const gw = gateway('process.list', () => ({ count: 2, extra: true }))

    await expect(rpcParsed(gw.client, 'process.list', { session_id: 's1' }, answer)).resolves.toEqual({ count: 2 })
  })

  it('rejects a shape the schema refuses, as a failed request does', async () => {
    await expect(rpcParsed(gateway('process.list', () => ({ count: 'two' })).client, 'process.list', { session_id: 's1' }, answer)).rejects.toThrow()
    await expect(rpcParsed(gateway('process.list', () => null).client, 'process.list', { session_id: 's1' }, answer)).rejects.toThrow()
  })
})

describe('processList', () => {
  it("reads the shared gateway's rows: a start time and a 32k tail", () => {
    const row = only(
      processList.parse({
        processes: [{ command: 'npm run dev', output_tail: 'ready\n', session_id: 'proc_a', started_epoch: NOW / 1000, status: 'running' }]
      })
    )

    expect(row).toEqual({ command: 'npm run dev', output_tail: 'ready\n', session_id: 'proc_a', started_epoch: NOW / 1000, status: 'running' })
    expect(foldEntry(undefined, row, NOW + 5000)).toMatchObject({ lastLine: 'ready', startedAt: NOW, status: 'running' })
  })

  it("reads the per-session gateway's rows: an uptime and an output preview", () => {
    const row = only(
      processList.parse({
        processes: [
          { command: 'make', exit_code: 2, exited_at: 1, output_preview: 'error 2', session_id: 'proc_b', status: 'exited', uptime_seconds: 30 }
        ]
      })
    )

    expect(foldEntry(undefined, row, NOW)).toMatchObject({ exitCode: 2, lastLine: 'error 2', startedAt: NOW - 30_000, status: 'failed' })
  })

  it('reads no answer, and an answer with no list, as no processes', () => {
    expect(processList.parse(null)).toEqual([])
    expect(processList.parse(undefined)).toEqual([])
    expect(processList.parse({})).toEqual([])
    expect(processList.parse({ processes: null })).toEqual([])
    expect(processList.parse('nope')).toEqual([])
  })

  it('skips a row with no id and drops a field of the wrong type', () => {
    const rows = processList.parse({
      processes: [null, { command: 'x' }, { session_id: 7 }, { command: 3, session_id: 'proc_c', status: 'running', uptime_seconds: 'long' }]
    })

    expect(rows).toEqual([{ session_id: 'proc_c', status: 'running' }])
  })
})

describe('pendingRows', () => {
  const row = { admission_id: 'a1', input_id: 'in-1', status: 'queued', target_profile_home: '/h', target_session_id: 's1', user: 'next' }

  it('reads the FIFO, keeping the fields the queue reads', () => {
    expect(pendingRows({ pending_submissions: [row] })).toEqual([{ admission_id: 'a1', input_id: 'in-1', status: 'queued', user: 'next' }])
  })

  it('keeps a row with a status it does not know, as neither waiting nor started', () => {
    expect(pendingRows({ pending_submissions: [{ ...row, status: 'steering' }, { ...row, admission_id: 'a2', status: 'started' }] })).toEqual([
      { admission_id: 'a1', input_id: 'in-1', status: 'other', user: 'next' },
      { admission_id: 'a2', input_id: 'in-1', status: 'started', user: 'next' }
    ])
  })

  it('is undefined when info carries no FIFO, so the queue keeps its rows', () => {
    expect(pendingRows(undefined)).toBeUndefined()
    expect(pendingRows(null)).toBeUndefined()
    expect(pendingRows({ title: 'x' })).toBeUndefined()
    expect(pendingRows({ pending_submissions: 'later' })).toBeUndefined()
    expect(pendingRows({ pending_submissions: [] })).toEqual([])
  })

  it('drops a row with no admission id, and reads a missing status or text', () => {
    expect(pendingRows({ pending_submissions: [null, { status: 'queued', user: 'x' }, { admission_id: 'a3' }] })).toEqual([
      { admission_id: 'a3', status: 'other', user: '' }
    ])
  })
})

describe('usageCounters', () => {
  it("reads the shared owner's counters at the top level", () => {
    expect(usageCounters({ cache_read_tokens: 40, prompt_tokens: 100, tokens_per_s: 52.5, total_tokens: 180 })).toEqual({
      counters: { prompt: 100, read: 40, total: 180 },
      tps: 52.5
    })
  })

  it('reads a tick that nests its usage (an older gateway), or none, as zeros', () => {
    const zeros = { counters: { prompt: 0, read: 0, total: 0 }, tps: undefined }

    expect(usageCounters({ usage: { input: 10, output: 5, total: 15 } })).toEqual(zeros)
    expect(usageCounters(undefined)).toEqual(zeros)
    expect(usageCounters('tick')).toEqual(zeros)
  })

  it('takes a counter Number reads, and refuses the tick when one is not a number', () => {
    expect(usageCounters({ prompt_tokens: '12', tokens_per_s: '9', total_tokens: null })).toEqual({
      counters: { prompt: 12, read: 0, total: 0 },
      tps: undefined
    })
    expect(usageCounters({ prompt_tokens: 'many' })).toBeUndefined()
  })
})
