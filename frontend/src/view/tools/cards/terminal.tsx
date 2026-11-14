// The terminal tool: omp's bash card, and a background start with its process's live line.

import type { JSX } from '@stencil-hq/tern'

import { clip } from '../../../core/text.js'
import type { ToolCall } from '../../../model.js'
import { PROCESS_LOOK } from '../../../processes/look.js'
import { isRunning as processRuns, processElapsed, processIdOf, processTone, processVerdict, watchersOf } from '../../../processes/store.js'
import { primaryNode } from '../../../processes/widgets/view.js'
import type { TerminalDetail } from '../../../tools/terminal.js'
import { commandDisplayText } from '../../../vendor/t3code/commandLabel.js'
import { commandLine, describeCommand } from '../../describe.js'
import { duration, flat } from '../../format.js'
import { age } from '../../time.js'
import type { Card, ToolView } from '../types.js'

/**
 * The terminal tool's view. A background start reports no exit (its process line tells how it
 * ended), and a short command that sat in the card's head opens a work group step.
 */
export const terminalView: ToolView<'terminal'> = {
  action: 'command',
  card: (call, d, now) => (d.background ? backgroundCard(call, d, now) : bashCard(call, d)),
  detailPrefix: (call, d) => {
    const command = commandOf(call, d)

    return command && command === commandLine(command)
      ? <code key="cmd" lang="bash" max={{ h: '12lines' }} role="omp.tool.command" text={command} />
      : undefined
  },
  exit: d => (d.background ? undefined : d.exit),
  hubIcon: 'bash',
  // The command as its text, without an `sh -c` wrapper.
  step: (call, d) => {
    const command = d.command ?? call.context

    return command ? flat(commandDisplayText(command)) : 'Command'
  }
}

const commandOf = (call: ToolCall, d: TerminalDetail) => (d.command ?? call.context ?? '').trim()

/** A command and its output. `instead`, when given, takes the output's place (a background call's process line). */
function bashCard(call: ToolCall, d: TerminalDetail, instead?: JSX.Element): Card {
  // The cancelled card's notice already says the command was interrupted.
  const output = (d.output ?? call.resultText)?.replace(/\s*\[Command interrupted\]\s*$/, '')
  const error = d.error
  const command = commandOf(call, d)
  const line = commandLine(command)
  const running = call.outcome.kind === 'running'

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
function backgroundCard(call: ToolCall, d: TerminalDetail, now: number): Card {
  const w = watchersOf(call)
  const id = processIdOf(call) ?? call.process?.id
  const line = id ? processLine(call, id, now) : undefined
  const chart = call.process?.chart && primaryNode(call.process.chart)
  // The start result ("Background process started") says nothing the process line does not.
  const card = bashCard(call, d, line && chart ? <col gap="xs" key="process">{line}{chart}</col> : line)

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
  const tone = p ? processTone(p.state.status) : 'muted'
  // Why the card draws no chart, where its glance would be.
  const note = p?.chart?.state === 'fallback' ? p.chart.note : undefined

  return (
    <row
      actions={{ click: `open-process=${id}`, menu: [`open-process=${id}`] }}
      align="center"
      gap="xs"
      key="process"
      role="omp.tool.process"
      title={`${note ? `${note}\n` : ''}Open in the Background sheet (the shells pill opens it too)  ⌥J`}
    >
      {p && live ? (
        <spinner key="state-icon" style="dots" tone="accent" />
      ) : (
        <icon key="state-icon" name={p ? PROCESS_LOOK[p.state.status].icon : 'pending'} tone={tone} />
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
