// A subagent's live transcript: the append-only log Hermes writes per delegated task
// (tools/delegation_live_log.py, `<home>/cache/delegation/live/<delegation>/task-<n>.log`).
// Every line after the header is `HH:MM:SS <role padded to 9>| <one-line text>`; the roles are
// user (kickoff), start, tool (`-> name(args)`), result (`name ok|ERROR 1.2s: text`), think,
// assistant and final (`status=… duration=…s summary: …`, then `end status=… exit_reason=…`).
// `subagent.tail` returns the last 16 KB of the same file, so a chunk may start mid-line.

export type LogEntry =
  | { kind: 'kickoff' | 'think' | 'assistant' | 'note'; at: string; text: string }
  | {
      kind: 'tool'
      at: string
      name: string
      args: string
      status: 'running' | 'ok' | 'error'
      /** Milliseconds, once the result line arrived with a duration. */
      took?: number
      result?: string
    }

export type LogStatus = 'completed' | 'failed' | 'error' | 'interrupted' | 'timeout' | (string & {})

export interface LiveLog {
  entries: LogEntry[]
  /** The final status, once a `final` line names one. */
  status?: LogStatus
  /** Seconds, from the completion marker. */
  duration?: number
  summary?: string
  /** `exit_reason=` of the end marker (max_iterations, …). */
  exitReason?: string
  error?: string
}

const LINE = /^(\d{2}:\d{2}:\d{2}) (\S+)\s*\| (.*)$/
const TOOL = /^-> ([^(]+)\((.*)\)$/
const RESULT = /^(\S+) (ok|ERROR)(?: ([\d.]+)s)?: ?(.*)$/

/** Parses a live log (or a tail of one); lines that don't parse, such as the header, are skipped. */
export function parseLiveLog(text: string): LiveLog {
  const log: LiveLog = { entries: [] }

  for (const raw of text.split('\n')) {
    const m = LINE.exec(raw)

    if (!m) {
      continue
    }

    const [, at, role, body] = m as unknown as [string, string, string, string]

    switch (role) {
      case 'user':
        log.entries.push({ at, kind: 'kickoff', text: body.replace(/^kickoff: /, '') })
        break

      case 'tool': {
        const t = TOOL.exec(body)
        log.entries.push({ args: t?.[2] ?? '', at, kind: 'tool', name: t?.[1]?.trim() || body, status: 'running' })
        break
      }

      case 'result': {
        const r = RESULT.exec(body)
        // The result answers the newest running call of that tool (calls run one at a time per child).
        const call = r && findLast(log.entries, e => e.kind === 'tool' && e.status === 'running' && e.name === r[1])

        if (call && call.kind === 'tool' && r) {
          call.status = r[2] === 'ok' ? 'ok' : 'error'
          call.result = r[4]
          call.took = r[3] ? Math.round(Number(r[3]) * 1000) : undefined
        }

        break
      }

      case 'think':
      case 'assistant':
        log.entries.push({ at, kind: role, text: body })
        break

      case 'start':
        break

      case 'final':
        final(log, at, body)
        break

      default:
        log.entries.push({ at, kind: 'note', text: body })
    }
  }

  return log
}

function final(log: LiveLog, at: string, body: string) {
  const status = /(?:^|\s)status=(\S+)/.exec(body)?.[1]

  if (status) {
    log.status = status
  }

  const duration = /(?:^|\s)duration=([\d.]+)s/.exec(body)?.[1]

  if (duration) {
    log.duration = Number(duration)
  }

  const summary = /summary: (.*)$/.exec(body)?.[1]

  if (summary) {
    log.summary = summary
  }

  const reason = /exit_reason=(\S+)/.exec(body)?.[1]

  if (reason) {
    log.exitReason = reason
  }

  const error = /error: (.*)$/.exec(body)?.[1]

  if (error) {
    log.error = error
  }

  if (!status && !duration && !summary) {
    log.entries.push({ at, kind: 'note', text: body })
  }
}

function findLast<T>(items: T[], match: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    if (match(items[i]!)) {
      return items[i]
    }
  }

  return undefined
}

/** The call still running at the end of the log, if any. */
export function runningTool(log: LiveLog): Extract<LogEntry, { kind: 'tool' }> | undefined {
  const last = findLast(log.entries, e => e.kind === 'tool')

  return last?.kind === 'tool' && last.status === 'running' ? last : undefined
}

/** `HH:MM:SS` (local, today; yesterday when that would be in the future) as epoch milliseconds. */
export function clockToMs(clock: string, now = Date.now()): number {
  const [h = 0, m = 0, s = 0] = clock.split(':').map(Number)
  const at = new Date(now).setHours(h, m, s, 0)

  return at > now + 60_000 ? at - 86_400_000 : at
}
