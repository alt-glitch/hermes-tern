// The terminal tool: omp's bash card, and a background start with its process's live line.

import type { JSX } from '@stencil-hq/tern'

import type { ToolCall } from '../../../model.js'
import { PROCESS_LOOK } from '../../../processes/look.js'
import { isRunning as processRuns, processElapsed, processIdOf, processTone, processVerdict, watchersOf } from '../../../processes/store.js'
import { primaryNode } from '../../../processes/widgets/view.js'
import { commandLine, describeCommand } from '../../describe.js'
import { clip, duration, nonEmpty } from '../../format.js'
import { age } from '../../time.js'
import type { Card } from '../types.js'

/** A command and its output. `instead`, when given, takes the output's place (a background call's process line). */
export function bashCard(call: ToolCall, result: Record<string, unknown> | undefined, instead?: JSX.Element): Card {
  // The cancelled card's notice already says the command was interrupted.
  const output = (nonEmpty(result?.output) ?? call.resultText)?.replace(/\s*\[Command interrupted\]\s*$/, '')
  const error = nonEmpty(result?.error)
  const command = (nonEmpty(call.args.command) ?? call.context ?? '').trim()
  const line = commandLine(command)
  const running = call.status === 'running'

  // The head says what the step is for and shows the command on one line, so it never grows
  // when the card opens; a command longer than that line opens into the body, above its output.
  return {
    body: [
      ...(command && command !== line
        ? [<code key="cmd" lang="bash" max={{ h: '12lines' }} role="omp.tool.command" text={command} />]
        : []),
      ...(instead ? [instead] : output ? [<ansi follow key="out" max={{ h: '20lines' }} text={output} />] : []),
      ...(error ? [<text key="err" role="omp.tool.error" spans={[{ s: 'error', t: error }]} wrap="word" />] : [])
    ],
    folded: true,
    lang: 'bash',
    name: 'bash',
    preview: { tail: running ? 4 : 3 },
    // A short command is the head's target; a longer one shows whole in the body instead.
    target: command === line ? line || undefined : undefined,
    targetKind: 'command',
    title: describeCommand(command)
  }
}

/**
 * A `terminal(background=true)` call: the bash card with a `background` badge and the watchers
 * Hermes armed, and, in place of the start notice, the process's live line from the store
 * (running · run time · last output line, then how it ended). A click on that line opens the
 * Background sheet on the process.
 */
export function backgroundCard(call: ToolCall, result: Record<string, unknown> | undefined, now: number): Card {
  const w = watchersOf(call)
  const id = processIdOf(call) ?? call.process?.id
  const line = id ? processLine(call, id, now) : undefined
  const chart = call.process?.chart && primaryNode(call.process.chart)
  // The start result ("Background process started") says nothing the process line does not.
  const card = bashCard(call, result, line && chart ? <col gap="xs" key="process">{line}{chart}</col> : line)

  return {
    ...card,
    badges: [
      { text: 'background' },
      ...(w.notify ? [{ text: 'notify on exit' }] : []),
      ...w.patterns.map(p => ({ text: `watch: ${clip(p, { mark: 'line', max: 32 })}` })),
      ...(w.heartbeat ? [{ text: `every ${w.heartbeat}s` }] : [])
    ],
    folded: line ? false : card.folded
  }
}

function processLine(call: ToolCall, id: string, now: number): JSX.Element {
  const p = call.process
  const live = !p || processRuns(p)
  const tone = p ? processTone(p.status) : 'muted'

  return (
    <row
      actions={{ click: `open-process=${id}`, menu: [`open-process=${id}`] }}
      align="center"
      gap="xs"
      key="process"
      role="omp.tool.process"
      title="Open in the Background sheet  ⌥J"
    >
      {p && live ? (
        <spinner key="state-icon" style="dots" tone="accent" />
      ) : (
        <icon key="state-icon" name={p ? PROCESS_LOOK[p.status].icon : 'pending'} tone={tone} />
      )}
      <text key="state" spans={[{ s: tone, t: p ? processVerdict(p) : 'starting' }]} wrap="none" />
      {p ? <text key="sep1" spans={[{ s: 'dim', t: '·' }]} wrap="none" /> : null}
      {p && live ? <elapsed age={age(p, p.startedAt, now)} format="short" key="time" /> : null}
      {p && !live ? <text key="took" spans={[{ s: 'muted', t: duration(processElapsed(p, now)) }]} wrap="none" /> : null}
      {p?.lastLine ? <text key="sep2" spans={[{ s: 'dim', t: '·' }]} wrap="none" /> : null}
      {p?.lastLine ? <text grow={1} key="last" spans={[{ s: 'muted mono', t: p.lastLine }]} truncate="end" wrap="none" /> : null}
    </row>
  )
}
