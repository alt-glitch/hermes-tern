// The goal's or the loop's sheet, opened from its part of the dock line: what stands, how far it
// got, the judge's last word, and the `session.control` verbs (pause or resume, stop the wait,
// clear or stop) desktop's status stack offers. Clearing and stopping ask first.

import type { JSX, Key, KvItem } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import type { AutomationAction, GoalView, LoopView } from '../automation.js'
import type { Overlay } from '../overlay.js'
import { countdownAge } from '../view/time.js'
import { loopWhen, turnsText } from '../view/automation.js'

import { actionsRow, type Button, confirmOverlay } from './prompts.js'

/** What the /goal and /loop sheets reach of the app. */
export type AutomationSheetHost = Pick<ChatPorts, 'automation' | 'changed' | 'close' | 'open'>

/** The sheet's buttons for the goal or the loop as it stands; the first is the plain key's. */
export function automationButtons(
  which: 'goal' | 'loop',
  view: Pick<GoalView, 'state'> | Pick<LoopView, 'state'>
): { action: AutomationAction; label: string; keys: string[]; confirm?: string }[] {
  if (which === 'goal') {
    return [
      view.state === 'paused'
        ? { action: 'goal.resume', keys: ['p'], label: 'Resume' }
        : { action: 'goal.pause', keys: ['p'], label: 'Pause' },
      ...(view.state === 'waiting' ? [{ action: 'goal.unwait' as const, keys: ['w'], label: 'Stop waiting' }] : []),
      { action: 'goal.clear', confirm: 'Clear the goal?', keys: ['x'], label: 'Clear' }
    ]
  }

  return [
    view.state === 'paused'
      ? { action: 'loop.resume', keys: ['p'], label: 'Resume' }
      : { action: 'loop.pause', keys: ['p'], label: 'Pause' },
    { action: 'loop.stop', confirm: 'Stop the loop?', keys: ['x'], label: 'Stop' }
  ]
}

const kv = (k: string, v: string, s?: string): KvItem => ({ k: [{ t: k }], v: [{ s, t: v }] })

function goalBody(g: GoalView): JSX.Element[] {
  const facts: KvItem[] = [
    kv('State', g.state),
    kv('Progress', turnsText(g)),
    ...(g.detail ? [kv(g.state === 'waiting' ? 'Waiting' : 'Why', g.detail)] : []),
    ...(g.verdict ? [kv('Last check', g.reason ? `${g.verdict} · ${g.reason}` : g.verdict)] : [])
  ]

  return [
    <md key="title" role="hermes.automation.title" text={g.title} />,
    ...(g.maxTurns > 0
      ? [
          <meter
            key="turns"
            label={[{ s: 'muted', t: 'turns' }]}
            style="bar"
            thresholds={{ bad: 0.9, warn: 0.75 }}
            total={[{ t: `${g.turns}/${g.maxTurns}` }]}
            value={Math.min(1, g.turns / g.maxTurns)}
          />
        ]
      : []),
    <kv items={facts} key="facts" />,
    ...(g.criteria.length
      ? [
          <col gap="xs" key="criteria">
            <text key="head" spans={[{ s: 'muted', t: 'Criteria' }]} />
            {g.criteria.map((c, i) => (
              <text key={`c${i}`} text={`${i + 1}. ${c}`} wrap="word" />
            ))}
          </col>
        ]
      : [])
  ]
}

function loopBody(l: LoopView, owner: object, now: number): JSX.Element[] {
  const facts: KvItem[] = [
    kv('Cadence', l.cadence),
    kv('Runs', l.runs),
    ...(l.until ? [kv('Until', l.until)] : []),
    ...(l.dueAt === undefined ? [kv('Next run', loopWhen(l))] : [])
  ]

  return [
    <md key="title" role="hermes.automation.title" text={l.prompt} />,
    ...(l.dueAt !== undefined
      ? [
          <row align="center" gap="xs" key="next">
            <icon key="i" name="timer" tone="accent" />
            <text key="t" spans={[{ s: 'muted', t: 'Next run in' }]} />
            <elapsed age={countdownAge(owner, l.dueAt, now)} format="short" key="countdown" />
          </row>
        ]
      : []),
    ...(l.times > 0
      ? [<meter key="runs" label={[{ s: 'muted', t: 'runs' }]} style="bar" total={[{ t: `${l.fired}/${l.times}` }]} value={Math.min(1, l.fired / l.times)} />]
      : []),
    <kv items={facts} key="facts" />
  ]
}

/** Opens the goal's or the loop's sheet; it closes itself once that is no longer standing. */
export function openAutomation(host: AutomationSheetHost, which: 'goal' | 'loop') {
  const key = `automation:${which}`

  const run = (b: ReturnType<typeof automationButtons>[number]) => {
    if (host.automation.pending) {
      return
    }

    if (b.confirm) {
      host.open(
        confirmOverlay(host, {
          confirm: b.label,
          detail: which === 'goal' ? 'Hermes stops working toward it. /goal sets a new one.' : 'No more runs. /loop starts a new one.',
          onConfirm: () => void host.automation.act(b.action),
          title: b.confirm
        })
      )

      return
    }

    void host.automation.act(b.action)
  }

  const current = () => (which === 'goal' ? host.automation.goal : host.automation.loop())

  const overlay: Overlay = {
    key,
    modal: true,
    node: () => {
      const now = Date.now()
      const view = current()

      if (!view) {
        // Done, cleared or stopped meanwhile (here or by another viewer): nothing left to show.
        queueMicrotask(() => host.close(overlay))

        return <overlay anchor="bottom" key={key} modal size="md" />
      }

      const pending = host.automation.pending
      const buttons: Button[] = [
        { hint: 'escape', key: 'close', keys: ['escape'], label: 'Close', onClick: () => host.close(overlay) },
        ...automationButtons(which, view).map((b, i) => ({
          hint: i === 0 ? `enter · ${b.keys.join(' · ')}` : b.keys.join(' · '),
          key: b.action,
          keys: b.keys,
          label: pending === b.action ? `${b.label}…` : b.label,
          onClick: () => run(b),
          primary: i === 0
        }))
      ]

      return (
        <overlay
          anchor="bottom"
          head={[{ t: which === 'goal' ? 'Goal' : 'Loop' }]}
          key={key}
          modal
          role="hermes.automation.sheet"
          size="md"
        >
          <col gap="md" key="body">
            {which === 'goal'
              ? goalBody(view as GoalView)
              : loopBody(view as LoopView, host.automation.loopSnapshot ?? view, now)}
            {actionsRow(buttons)}
          </col>
        </overlay>
      )
    },
    onKey: (k: Key) => {
      if (k.name === 'escape') {
        host.close(overlay)

        return true
      }

      const view = current()
      const b = view ? automationButtons(which, view).find(b => b.keys.includes(k.name) && !k.ctrl && !k.meta) : undefined

      if (b) {
        run(b)
      } else if (k.name === 'enter' && view) {
        run(automationButtons(which, view)[0]!)
      }

      return true
    }
  }

  host.open(overlay)
}
