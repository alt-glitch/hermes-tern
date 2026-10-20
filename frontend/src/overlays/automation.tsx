// The goal's or the loop's sheet, opened from its part of the dock line: what stands, how far it
// got, the judge's last word, and the `session.control` verbs (pause or resume, stop the wait,
// clear or stop) desktop's status stack offers. Clearing and stopping ask first.

import type { JSX, Key, KvItem } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import type { NonEmpty } from '../core/assert.js'
import { optional } from '../core/assert.js'
import type { AutomationAction, GoalView, LoopView } from '../session/automation.js'
import { loopWhen, turnsText } from '../view/automation.js'
import { countdownAge } from '../view/time.js'
import { actionsRow, type ButtonProps } from '../view/ui/button.js'

import type { Overlay } from './overlay.js'
import { confirmOverlay } from './prompts.js'

/** What the /goal and /loop sheets reach of the app. */
export type AutomationSheetHost = Pick<ChatPorts, 'automation' | 'changed' | 'close' | 'open'>

/** One of the sheet's buttons: the verb it sends, its keys, and the question it asks first, if any. */
export interface AutomationButton {
  action: AutomationAction
  label: string
  keys: string[]
  confirm?: string
}

/** What the sheet shows: the standing goal, or the standing loop. */
export type AutomationSheet = { which: 'goal'; view: GoalView } | { which: 'loop'; view: LoopView }

/** The sheet's buttons for the goal or the loop as it stands; the first is the plain key's. */
export function automationButtons(
  which: AutomationSheet['which'],
  view: Pick<GoalView, 'state'> | Pick<LoopView, 'state'>
): NonEmpty<AutomationButton> {
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

const kv = (k: string, v: string, s?: string): KvItem => ({ k: [{ t: k }], v: [{ ...optional('s', s), t: v }] })

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
export function openAutomation(host: AutomationSheetHost, which: AutomationSheet['which']) {
  const key = `automation:${which}`

  const run = (b: AutomationButton) => {
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

  const current = (): AutomationSheet | undefined => {
    if (which === 'goal') {
      const view = host.automation.goal

      return view ? { view, which } : undefined
    }

    const view = host.automation.loop()

    return view ? { view, which } : undefined
  }

  /** Done, cleared or stopped meanwhile (here or by another viewer): nothing left to show, so the sheet goes (after the change's own work). */
  const closeIfGone = () => {
    if (!current()) {
      queueMicrotask(() => host.close(overlay))
    }
  }

  const unwatch = host.automation.watch(closeIfGone)

  const overlay: Overlay = {
    key,
    modal: true,
    onClose: unwatch,
    node: () => {
      const now = Date.now()
      const sheet = current()

      if (!sheet) {
        return <overlay anchor="bottom" key={key} modal size="md" />
      }

      const pending = host.automation.pending
      const buttons: ButtonProps[] = [
        { hint: 'escape', key: 'close', keys: ['escape'], label: 'Close', onClick: () => host.close(overlay) },
        ...automationButtons(sheet.which, sheet.view).map((b, i): ButtonProps => ({
          hint: i === 0 ? `enter · ${b.keys.join(' · ')}` : b.keys.join(' · '),
          key: b.action,
          keys: b.keys,
          ...(i === 0 ? { kind: 'primary' } : {}),
          label: pending === b.action ? `${b.label}…` : b.label,
          onClick: () => run(b)
        }))
      ]

      return (
        <overlay
          anchor="bottom"
          head={[{ t: sheet.which === 'goal' ? 'Goal' : 'Loop' }]}
          key={key}
          modal
          role="hermes.automation.sheet"
          size="md"
        >
          <col gap="md" key="body">
            {sheet.which === 'goal' ? goalBody(sheet.view) : loopBody(sheet.view, host.automation.loopSnapshot ?? sheet.view, now)}
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

      const sheet = current()
      const offered = sheet ? automationButtons(sheet.which, sheet.view) : undefined
      const b = offered?.find(b => b.keys.includes(k.name) && !k.ctrl && !k.meta)

      if (b) {
        run(b)
      } else if (k.name === 'enter' && offered) {
        run(offered[0])
      }

      return true
    }
  }

  host.open(overlay)
  // Opened on nothing (it went in the same turn): the sheet goes at once.
  closeIfGone()
}
