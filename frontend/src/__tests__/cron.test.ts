import type { GatewayClient } from '@tui/gatewayClient.js'
import { describe, expect, it, vi } from 'vitest'

import { toolCallId } from '../core/ids.js'
import type { ToolCall } from '../model.js'
import { Cron, type CronJob, isMonitor, isPaused, jobTone, ownJobs, relative } from '../processes/cron.js'

const NOW = Date.parse('2026-10-17T12:00:00Z')

const job = (over: Partial<CronJob> = {}): CronJob => ({ enabled: true, job_id: 'j1', name: 'digest', schedule: 'every 30m', ...over })

const call = (name: string, result: unknown): ToolCall => ({
  args: {},
  argsText: '',
  context: '',
  id: toolCallId('c'),
  name,
  result: JSON.stringify(result),
  startedAt: 0,
  outcome: { duration: 0, kind: 'done' },
  via: { kind: 'direct' }
})

describe('cron jobs', () => {
  it('reads state, monitors and tone from a list row', () => {
    expect(isMonitor(job({ monitor_url: 'https://example.com' }))).toBe(true)
    expect(isMonitor(job())).toBe(false)
    expect(isPaused(job({ enabled: false }))).toBe(true)
    expect(isPaused(job({ state: 'paused' }))).toBe(true)
    expect(jobTone(job())).toBe('accent')
    expect(jobTone(job({ last_error: 'boom' }))).toBe('error')
    expect(jobTone(job({ enabled: false, last_error: 'boom' }))).toBe('muted')
  })

  it('knows the jobs this session made from its cronjob_manage results', () => {
    const calls = [
      call('cronjob_manage', { job_id: 'a', success: true }),
      call('cronjob_manage', { job: { job_id: 'b' }, success: true }),
      call('cronjob_manage', { error: 'nope', success: false }),
      call('terminal', { job_id: 'c' })
    ]

    expect([...ownJobs(calls)]).toEqual(['a', 'b'])
  })

  it('says how far a time is in its largest whole unit', () => {
    const at = (ms: number) => new Date(NOW + ms).toISOString()

    expect(relative(at(10_000), NOW)).toBe('now')
    expect(relative(at(29 * 60_000), NOW)).toBe('in 29m')
    expect(relative(at(-3 * 3_600_000), NOW)).toBe('3h ago')
    expect(relative(at(2 * 86_400_000), NOW)).toBe('in 2d')
    expect(relative(null, NOW)).toBe('')
  })
})

describe('Cron', () => {
  it('lists paused jobs too, acts by id and keeps the error when the gateway refuses', async () => {
    const request = vi.fn(
      async (_method: string, params: Record<string, unknown>): Promise<{ error?: string; jobs?: CronJob[]; success: boolean }> =>
        params.action === 'list' ? { jobs: [job()], success: true } : { success: true }
    )
    const cron = new Cron({ changed: vi.fn(), gw: { request } as unknown as Pick<GatewayClient, 'request'> })

    await cron.refresh()
    expect(request).toHaveBeenCalledWith('cron.manage', { action: 'list', include_disabled: true })
    expect(cron.jobs().map(j => j.job_id)).toEqual(['j1'])

    await cron.act('pause', 'j1')
    expect(request).toHaveBeenCalledWith('cron.manage', { action: 'pause', name: 'j1' })

    request.mockResolvedValueOnce({ error: 'Job not found', success: false })
    await expect(cron.act('remove', 'zz')).rejects.toThrow('Job not found')

    request.mockRejectedValueOnce(new Error('method not found'))
    await cron.refresh()
    expect(cron.error).toBe('method not found')
  })
})
