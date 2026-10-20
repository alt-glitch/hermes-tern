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

const LINE = /^(?<at>\d{2}:\d{2}:\d{2}) (?<role>\S+)\s*\| (?<body>.*)$/
const TOOL = /^-> (?<name>[^(]+)\((?<args>.*)\)$/
const RESULT = /^(?<name>\S+) (?<status>ok|ERROR)(?: (?<secs>[\d.]+)s)?: ?(?<text>.*)$/

/** Parses a live log (or a tail of one); lines that don't parse, such as the header, are skipped. */
export function parseLiveLog(text: string): LiveLog {
  const log: LiveLog = { entries: [] }

  for (const raw of text.split('\n')) {
    const m = LINE.exec(raw)

    if (!m) {
      continue
    }

    // A match fills every group of LINE; the defaults only satisfy the index signature.
    const { at = '', body = '', role = '' } = m.groups ?? {}

    switch (role) {
      case 'user':
        log.entries.push({ at, kind: 'kickoff', text: body.replace(/^kickoff: /, '') })
        break

      case 'tool': {
        const t = TOOL.exec(body)?.groups
        log.entries.push({ args: t?.['args'] ?? '', at, kind: 'tool', name: t?.['name']?.trim() || body, status: 'running' })
        break
      }

      case 'result': {
        const r = RESULT.exec(body)?.groups
        // The result answers the newest running call of that tool (calls run one at a time per child).
        const call = r && log.entries.findLast(e => e.kind === 'tool' && e.status === 'running' && e.name === r['name'])

        if (call && call.kind === 'tool' && r) {
          const { secs, status, text = '' } = r
          call.status = status === 'ok' ? 'ok' : 'error'
          call.result = text

          // A running call has no duration yet, so one without a duration stays without.
          if (secs) {
            call.took = Math.round(Number(secs) * 1000)
          }
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

/** The call still running at the end of the log, if any. */
export function runningTool(log: LiveLog): Extract<LogEntry, { kind: 'tool' }> | undefined {
  const last = log.entries.findLast(e => e.kind === 'tool')

  return last?.kind === 'tool' && last.status === 'running' ? last : undefined
}

/** `HH:MM:SS` (local, today; yesterday when that would be in the future) as epoch milliseconds. */
export function clockToMs(clock: string, now = Date.now()): number {
  const [h = 0, m = 0, s = 0] = clock.split(':').map(Number)
  const at = new Date(now).setHours(h, m, s, 0)

  return at > now + 60_000 ? at - 86_400_000 : at
}
