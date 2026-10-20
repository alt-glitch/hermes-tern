// Hermes' cron jobs, for the Background sheet's Cron tab: every job of the profile's cron store
// (cron.manage `list`, paused ones too), not only this session's. A job a `cronjob_manage` call of this
// session created is marked as its own. The list polls every five seconds while the tab shows;
// pause, resume and remove go through the same method.

import type { CronJobRow } from '@hermes/shared/gateway-events'
import type { GatewayClient } from '@tui/gatewayClient.js'

import { errorText } from '../core/errors.js'
import { Poller } from '../core/poller.js'
import type { ToolCall } from '../model.js'
import { record } from '../wire/json.js'
import { rpc } from '../wire/rpc.js'

/** One row of `cron.manage` `list` (tools/cronjob_job_args.py `_format_job`). */
export type CronJob = CronJobRow

export const CRON_POLL_MS = 5000

/** What the store reaches of the app. */
export interface CronHost {
  readonly gw: Pick<GatewayClient, 'request'>
  changed(): void
}

export type CronAction = 'pause' | 'remove' | 'resume'

/** A job that watches a script or a URL and wakes the agent when it changes. */
export function isMonitor(job: CronJob): boolean {
  return Boolean(job.monitor_script || job.monitor_url)
}

export function isPaused(job: CronJob): boolean {
  return job.enabled === false || job.state === 'paused'
}

/** A failed last run, a failed delivery or a failed fire. */
export function jobError(job: CronJob): string | undefined {
  return job.last_error || job.last_fire_error || job.last_delivery_error || undefined
}

export function jobTone(job: CronJob): 'accent' | 'error' | 'muted' {
  return isPaused(job) ? 'muted' : jobError(job) || job.last_status === 'error' ? 'error' : 'accent'
}

/** The ids of the jobs this session's `cronjob_manage` calls created (each create result names its job). */
export function ownJobs(calls: readonly ToolCall[]): Set<string> {
  const ids = new Set<string>()

  for (const c of calls) {
    const r = record(c.result)
    const job = record(r?.['job'])
    const id = r?.['job_id'] ?? job?.['job_id'] ?? job?.['id']

    if (c.name === 'cronjob_manage' && typeof id === 'string' && id) {
      ids.add(id)
    }
  }

  return ids
}

export class Cron {
  readonly #host: CronHost
  #jobs: CronJob[] = []
  #error: string | undefined
  #warning: string | undefined
  #loaded = false
  /** The list's poll: every CRON_POLL_MS while the Cron tab shows, else none. */
  readonly #poller: Poller = new Poller({
    cadence: () => (this.#poller.watched ? CRON_POLL_MS : 'off'),
    // A round scheduled before the tab closed reads nothing.
    run: async () => (this.#poller.watched ? this.refresh() : undefined)
  })
  #busy = new Set<string>()

  constructor(host: CronHost) {
    this.#host = host
  }

  jobs(): CronJob[] {
    return this.#jobs
  }

  /** Why the list could not load (an old gateway, a refused scope). */
  get error(): string | undefined {
    return this.#error
  }

  /** The gateway's note that no scheduler runs (the jobs are saved but do not fire). */
  get warning(): string | undefined {
    return this.#warning
  }

  get loaded(): boolean {
    return this.#loaded
  }

  /** An action is in flight for `id`. */
  busy(id: string): boolean {
    return this.#busy.has(id)
  }

  /** Polls while the returned release has not run (the Cron tab shows). */
  watch(): () => void {
    return this.#poller.watch()
  }

  /** Stops polling for good (the pane quits). */
  dispose() {
    this.#poller.dispose()
  }

  /** Pauses, resumes or removes job `id`; throws the gateway's error. */
  async act(action: CronAction, id: string): Promise<void> {
    this.#busy.add(id)
    this.#host.changed()

    try {
      const r = await rpc(this.#host.gw, 'cron.manage', { action, name: id })

      if (r?.success === false || r?.error) {
        throw new Error(r.error || `Could not ${action} the job`)
      }
    } finally {
      this.#busy.delete(id)
      await this.refresh()
    }
  }

  async refresh() {
    try {
      const r = await rpc(this.#host.gw, 'cron.manage', { action: 'list', include_disabled: true })

      if (r?.success === false && r.error) {
        throw new Error(r.error)
      }

      this.#jobs = (r?.jobs ?? []).filter(j => typeof j?.job_id === 'string')
      this.#warning = r?.warning ?? undefined
      this.#error = undefined
    } catch (error) {
      this.#error = errorText(error)
    }

    this.#loaded = true
    this.#host.changed()
  }
}

/** `in 12m`, `3h ago`, `now`: how far `iso` is from `now`, in its largest whole unit. */
export function relative(iso: string | null | undefined, now: number): string {
  const at = iso ? Date.parse(iso) : NaN

  if (Number.isNaN(at)) {
    return ''
  }

  const d = at - now
  const s = Math.abs(d) / 1000
  const [n, unit] = s < 45 ? [0, ''] : s < 3600 ? [Math.round(s / 60), 'm'] : s < 86_400 ? [Math.round(s / 3600), 'h'] : [Math.round(s / 86_400), 'd']

  return n === 0 ? 'now' : d > 0 ? `in ${n}${unit}` : `${n}${unit} ago`
}
