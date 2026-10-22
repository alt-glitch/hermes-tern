// The transcript's lines for background work that ended: a subagent (`Agent "Survey the docs"
// finished · 4m 33s`) and a background process (`Background task keep-dump.sh exited (0) · 11m
// 30s`), as Claude Code writes `Agent "X" finished · 10s` when one of its background agents ends.

import { clip } from '../core/text.js'
import type { BackgroundProcess, NoticeEntry, Subagent } from '../model.js'

import { describeCommand } from './describe.js'
import { durationWhole, flat } from './format.js'

/** One line: its words and how it is toned. */
export interface BackgroundLine {
  text: string
  tone: NoticeEntry['tone']
}

const AGENT_END: Record<Subagent['status'], { verb: string; tone: NoticeEntry['tone'] }> = {
  cancelled: { tone: 'warning', verb: 'was stopped' },
  done: { tone: 'success', verb: 'finished' },
  failed: { tone: 'error', verb: 'failed' },
  queued: { tone: 'info', verb: 'is queued' },
  running: { tone: 'info', verb: 'is running' }
}

/** A subagent that ended: its goal's first line (else its name), how it ended, how long it ran. */
export function agentFinishedLine(a: Subagent): BackgroundLine {
  const goal = clip(flat(a.goal.split('\n')[0] ?? ''), { max: 60 })
  const name = goal ? `Agent "${goal}"` : (a.name ?? `Agent ${a.index + 1}`)
  const { tone, verb } = AGENT_END[a.status]
  const took = a.duration === undefined ? '' : ` · ${durationWhole(a.duration)}`

  return { text: `${name} ${verb}${took}`, tone }
}

/** A background process that ended: its command as a short title, how it ended, how long it ran. */
export function processExitedLine(p: BackgroundProcess): BackgroundLine {
  const title = clip(describeCommand(p.command).replace(/^Run /, ''), { max: 60 })
  const state = p.state
  const exitedAt = 'exitedAt' in state ? state.exitedAt : undefined
  const took = exitedAt === undefined ? '' : ` · ${durationWhole(exitedAt - p.startedAt)}`
  const [how, tone]: [string, NoticeEntry['tone']] =
    state.status === 'done'
      ? [`exited (${state.exitCode ?? 0})`, 'success']
      : state.status === 'failed'
        ? [state.reason === 'failed_start' ? 'failed to start' : `exited (${state.exitCode ?? '?'})`, 'error']
        : state.status === 'killed'
          ? ['was stopped', 'warning']
          : state.status === 'lost'
            ? ['was lost (its gateway restarted)', 'warning']
            : [state.status, 'info']

  return { text: `Background task ${title} ${how}${took}`, tone }
}
