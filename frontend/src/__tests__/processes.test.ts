import type { GatewayClient } from '@tui/gatewayClient.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { liveSessionId } from '../core/ids.js'
import type { BackgroundProcess } from '../model.js'
import {
  FAST_MS,
  foldEntry,
  IDLE_MS,
  isRecent,
  lastLine,
  Processes,
  processStatus,
  processVerdict,
  RETAIN_MS,
  sortProcesses,
  watchersOf
} from '../processes/store.js'
import { Transcript } from '../transcript.js'
import type { ProcessRow } from '../wire/schemas.js'

import { FakeGateway, must } from './fakes.js'

const NOW = 1_800_000_000_000

const proc = (id: string, over: Partial<BackgroundProcess> = {}): BackgroundProcess => ({
  command: `cmd ${id}`,
  id,
  lastLine: '',
  output: '',
  startedAt: NOW - 10_000,
  status: 'running',
  ...over
})

describe('processStatus', () => {
  it('maps the registry state as Hermes does', () => {
    expect(processStatus({ status: 'running' })).toBe('running')
    expect(processStatus({ exit_code: 0, status: 'exited' })).toBe('done')
    expect(processStatus({ exit_code: 2, status: 'exited' })).toBe('failed')
    expect(processStatus({ completion_reason: 'killed', exit_code: -15, status: 'exited' })).toBe('killed')
    expect(processStatus({ completion_reason: 'lost', status: 'exited' })).toBe('lost')
    expect(processStatus({ completion_reason: 'failed_start', exit_code: 0, status: 'exited' })).toBe('failed')
  })
})

describe('lastLine', () => {
  it('takes the last non-empty line, without escapes, newest redraw of a \\r line', () => {
    expect(lastLine('tick 1\ntick 2\n\n  \n')).toBe('tick 2')
    expect(lastLine('\x1b[32mok\x1b[0m   done\n')).toBe('ok done')
    expect(lastLine('building\n 10%\r 50%\r 90%\r')).toBe('90%')
    expect(lastLine('')).toBe('')
  })
})

describe('foldEntry', () => {
  it('reads the shared gateway projection and keeps the same object across polls', () => {
    const entry: ProcessRow = {
      command: 'for i in 1 2; do echo $i; done',
      output_tail: 'tick 1\ntick 2\n',
      session_id: 'proc_a',
      started_epoch: (NOW - 5000) / 1000,
      status: 'running'
    }
    const p = foldEntry(undefined, entry, NOW)

    expect(p).toMatchObject({ id: 'proc_a', lastLine: 'tick 2', startedAt: NOW - 5000, status: 'running' })

    const q = foldEntry(p, { ...entry, completion_reason: 'killed', exit_code: -15, exited_at: NOW / 1000, status: 'exited' }, NOW)

    expect(q).toBe(p)
    expect(q).toMatchObject({ exitCode: -15, exitedAt: NOW, reason: 'killed', status: 'killed' })
    expect(processVerdict(q)).toBe('killed')
  })

  it('derives the start from uptime once, on the per-session gateway', () => {
    const p = foldEntry(undefined, { output_preview: 'x', session_id: 'p', status: 'running', uptime_seconds: 30 }, NOW)

    expect(p.startedAt).toBe(NOW - 30_000)
    expect(foldEntry(p, { session_id: 'p', status: 'running', uptime_seconds: 31 }, NOW + 1500).startedAt).toBe(NOW - 30_000)
  })
})

describe('retention and order', () => {
  it('keeps exits for 60 s; one with no exit time leaves at once', () => {
    expect(isRecent(proc('a'), NOW)).toBe(true)
    expect(isRecent(proc('b', { exitedAt: NOW - RETAIN_MS, status: 'done' }), NOW)).toBe(true)
    expect(isRecent(proc('c', { exitedAt: NOW - RETAIN_MS - 1, status: 'done' }), NOW)).toBe(false)
    expect(isRecent(proc('d', { status: 'failed' }), NOW)).toBe(false)
  })

  it('lists running first (longest running first), then exits newest first', () => {
    const list = [
      proc('exited-old', { exitedAt: NOW - 30_000, status: 'done' }),
      proc('young', { startedAt: NOW - 1000 }),
      proc('exited-new', { exitedAt: NOW - 1000, status: 'failed' }),
      proc('old', { startedAt: NOW - 60_000 })
    ]

    expect(sortProcesses(list).map(p => p.id)).toEqual(['old', 'young', 'exited-new', 'exited-old'])
  })
})

describe('watchersOf', () => {
  it('reads what the start result says Hermes armed', () => {
    const result = JSON.stringify({ heartbeat_seconds: 60, notify_on_complete: true, session_id: 'proc_a' })

    expect(watchersOf({ args: { background: true, notify: ['ready'] }, result })).toEqual({
      heartbeat: 60,
      notify: true,
      patterns: []
    })
  })

  it('reads the arguments before the result arrives', () => {
    expect(watchersOf({ args: { background: true, notify: ['tick 10'] } })).toEqual({ heartbeat: 0, notify: false, patterns: ['tick 10'] })
    expect(watchersOf({ args: { background: true, notify_on_complete: true } })).toEqual({ heartbeat: 0, notify: true, patterns: [] })
    // A heartbeat implies notify-on-exit, is at least 60 s, and notify-on-exit drops patterns.
    expect(watchersOf({ args: { heartbeat: 30, watch_patterns: ['x'] } })).toEqual({ heartbeat: 60, notify: true, patterns: [] })
  })
})

describe('Processes', () => {
  afterEach(() => vi.useRealTimers())

  it('follows process.list and links the background card that started each process', async () => {
    vi.useFakeTimers({ now: NOW })
    const transcript = new Transcript()
    transcript.start()
    transcript.toolStart({ args: { background: true, command: 'sleep 90' }, name: 'terminal', tool_id: 't1' })
    transcript.toolComplete({
      name: 'terminal',
      result: JSON.stringify({ exit_code: 0, output: 'Background process started', session_id: 'proc_a' }),
      tool_id: 't1'
    })

    let rows: ProcessRow[] = [
      { command: 'sleep 90', output_tail: 'tick 1\n', session_id: 'proc_a', started_epoch: NOW / 1000, status: 'running' }
    ]
    const request = vi.fn(async (method: string) => (method === 'process.list' ? { processes: rows } : {}))
    const changed = vi.fn()
    const store = new Processes({ changed, gw: { request } as unknown as Pick<GatewayClient, 'request'>, sid: liveSessionId('s1'), transcript })

    store.poke()
    await vi.advanceTimersByTimeAsync(0)

    expect(request).toHaveBeenCalledWith('process.list', { session_id: 's1' })
    expect(store.running().map(p => p.id)).toEqual(['proc_a'])
    expect(transcript.backgroundCalls()[0]?.process?.lastLine).toBe('tick 1')
    expect(changed).toHaveBeenCalled()

    // It exits; the pill keeps it for the retention window, then drops it.
    rows = [{ ...rows[0]!, exit_code: 0, exited_at: (NOW + 1000) / 1000, status: 'exited' }]
    await vi.advanceTimersByTimeAsync(1000)

    expect(store.recent().map(p => p.status)).toEqual(['done'])
    await vi.advanceTimersByTimeAsync(RETAIN_MS + 5000)
    expect(store.recent()).toEqual([])
    expect(store.all().map(p => p.id)).toEqual(['proc_a'])
    store.dispose()
  })

  it('adds printed output to its process as it arrives, and polls for a process it does not know', async () => {
    vi.useFakeTimers({ now: NOW })
    const transcript = new Transcript()
    const rows: ProcessRow[] = [{ command: 'sleep 90', output_tail: 'tick 1\n', session_id: 'proc_a', status: 'running' }]
    const request = vi.fn(async () => ({ processes: rows }))
    const store = new Processes({ changed: vi.fn(), gw: { request } as unknown as Pick<GatewayClient, 'request'>, sid: liveSessionId('s1'), transcript })

    store.poke()
    await vi.advanceTimersByTimeAsync(0)
    store.output('proc_a', 'tick 2\n')

    expect(store.get('proc_a')?.output).toBe('tick 1\ntick 2\n')
    expect(store.get('proc_a')?.lastLine).toBe('tick 2')

    request.mockClear()
    store.output('proc_new', 'hello\n')
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledWith('process.list', { session_id: 's1' })
    store.dispose()
  })

  it("shows its processes as 'unknown' after three failed polls in a row, polls slower, and takes the answer back", async () => {
    vi.useFakeTimers({ now: NOW })
    let down = false
    const rows: ProcessRow[] = [{ command: 'sleep 90', session_id: 'proc_a', started_epoch: NOW / 1000, status: 'running' }]
    const gw = new FakeGateway({
      replies: {
        'process.list': () => {
          if (down) {
            throw new Error('gateway gone')
          }

          return { processes: rows }
        }
      }
    })
    const polls = () => gw.methods('process.list').length
    const changed = vi.fn()
    const store = new Processes({ changed, gw: gw.client, sid: liveSessionId('s1'), transcript: new Transcript() })

    store.poke()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get('proc_a')?.status).toBe('running')

    // Two failures could be a blip: it still runs, polled every second.
    down = true
    await vi.advanceTimersByTimeAsync(2 * FAST_MS)
    expect(store.get('proc_a')?.status).toBe('running')

    changed.mockClear()
    await vi.advanceTimersByTimeAsync(FAST_MS)
    const p = must(store.get('proc_a'))
    expect(p.status).toBe('unknown')
    expect(processVerdict(p)).toBe('unknown')
    expect(store.recent()).toEqual([p])
    expect(changed).toHaveBeenCalled()

    // Polled at the idle cadence while no answer comes.
    const before = polls()
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    expect(polls()).toBe(before)
    await vi.advanceTimersByTimeAsync(1)
    expect(polls()).toBe(before + 1)

    down = false
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(store.get('proc_a')?.status).toBe('running')
    store.dispose()
  })
})
