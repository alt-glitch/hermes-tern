// The dock's quiet lines above the composer: the standing goal and loop (one line, a part each,
// a click opens its sheet), and the reconnect notice while the gateway is being redialled. Nothing
// is drawn when nothing stands. Countdowns are Tern's `elapsed` with a negative age, so the pane
// ticks them without a render.

import type { JSX, Tone } from '@stencil-hq/tern'

import type { GoalState, GoalView, LoopView } from '../automation.js'

import { countdownAge } from './time.js'

/** The goal and loop line's model. */
export interface AutomationLine {
  goal: GoalView | null
  loop: LoopView | null
  /** The loop's snapshot: its countdown keeps the age it was first sent with until the next update. */
  loopOwner: object | null
  onGoal(): void
  onLoop(): void
}

/** The gateway is being redialled: which try, and when the next one starts. */
export interface Reconnecting {
  attempt: number
  /** When the next try starts (ms since the epoch). */
  dueAt: number
}

const GOAL_LOOK: Record<GoalState, { icon: string; label: string; tone: Tone }> = {
  active: { icon: 'goal', label: 'Goal', tone: 'accent' },
  blocked: { icon: 'goal', label: 'Goal blocked', tone: 'error' },
  paused: { icon: 'pause', label: 'Goal paused', tone: 'warning' },
  waiting: { icon: 'timer', label: 'Goal waiting', tone: 'warning' }
}

/** `3/20 turns` against a budget, else `turn 3`. */
export function turnsText(g: Pick<GoalView, 'maxTurns' | 'turns'>): string {
  return g.maxTurns > 0 ? `${g.turns}/${g.maxTurns} turns` : g.turns ? `turn ${g.turns}` : 'not started'
}

/** What the loop's line says about its next run. */
export function loopWhen(l: LoopView): string {
  switch (l.state) {
    case 'running':
      return 'running now'

    case 'deferred':
      return 'waits for the goal'

    case 'due':
      return 'due, waiting for idle'

    case 'paused':
      return l.detail || 'paused'

    default:
      return 'next in'
  }
}

/** The goal and loop line, or null when neither stands. */
export function automationNode(a: AutomationLine | undefined, now: number, focused?: string): JSX.Element | null {
  const parts = [
    a?.goal ? goalPart(a.goal, a.onGoal, focused === 'goal') : null,
    a?.loop ? loopPart(a.loop, a.loopOwner ?? a.loop, a.onLoop, now, focused === 'loop') : null
  ].filter(p => p !== null)

  return parts.length ? (
    <row align="center" gap="sm" key="automation" role="hermes.automation" wrap>
      {parts}
    </row>
  ) : null
}

function goalPart(g: GoalView, onOpen: () => void, focused: boolean): JSX.Element {
  const look = GOAL_LOOK[g.state]
  const judged = g.verdict ? `\nLast check: ${g.verdict}${g.reason ? ` · ${g.reason}` : ''}` : ''

  return (
    <row
      align="center"
      gap="xs"
      key="goal"
      mark={focused ? 'pick' : undefined}
      onClick={onOpen}
      role="hermes.automation.item"
      title={`${look.label}: ${g.title}\n${turnsText(g)}${g.detail ? ` · ${g.detail}` : ''}${judged}\nClick for details and controls`}
    >
      <icon key="icon" name={look.icon} tone={look.tone} />
      <text key="label" role="hermes.automation.label" text={look.label} wrap="none" />
      <text grow={1} key="what" role="hermes.automation.what" text={g.title} truncate="end" wrap="none" />
      {g.detail ? <text key="detail" spans={[{ s: 'muted', t: g.detail }]} truncate="end" wrap="none" /> : null}
      {g.maxTurns > 0 ? (
        <meter key="turns" size="sm" style="bar" thresholds={{ bad: 0.9, warn: 0.75 }} value={Math.min(1, g.turns / g.maxTurns)} />
      ) : null}
      <text key="count" role="hermes.automation.count" spans={[{ s: 'muted', t: g.maxTurns > 0 ? `${g.turns}/${g.maxTurns}` : turnsText(g) }]} wrap="none" />
    </row>
  )
}

function loopPart(l: LoopView, owner: object, onOpen: () => void, now: number, focused: boolean): JSX.Element {
  const paused = l.state === 'paused'
  const when = loopWhen(l)

  return (
    <row
      align="center"
      gap="xs"
      key="loop"
      mark={focused ? 'pick' : undefined}
      onClick={onOpen}
      role="hermes.automation.item"
      title={`${paused ? 'Loop paused' : 'Loop'}: ${l.prompt}\n${l.cadence} · ${l.runs}${l.until ? ` · until ${l.until}` : ''}\nClick for details and controls`}
    >
      {l.state === 'running' ? (
        <spinner key="icon" style="dots" tone="accent" />
      ) : (
        <icon key="icon" name={paused ? 'pause' : 'loop'} tone={paused ? 'warning' : l.state === 'deferred' ? 'muted' : 'accent'} />
      )}
      <text key="label" role="hermes.automation.label" text={paused ? 'Loop paused' : 'Loop'} wrap="none" />
      <text grow={1} key="what" role="hermes.automation.what" text={l.prompt} truncate="end" wrap="none" />
      <text key="cadence" spans={[{ s: 'muted', t: `${l.cadence} · ${when}` }]} wrap="none" />
      {l.dueAt !== undefined ? (
        <elapsed age={countdownAge(owner, l.dueAt, now)} format="short" key="countdown" role="hermes.automation.count" />
      ) : null}
    </row>
  )
}

/** One replaceable line while the gateway is redialled: the try, and a countdown to the next. */
export function reconnectNode(r: (Reconnecting & object) | undefined, now: number): JSX.Element | null {
  if (!r) {
    return null
  }

  const waiting = r.dueAt > now

  return (
    <row
      align="center"
      gap="xs"
      key="reconnect"
      role="hermes.reconnect"
      title="The connection to Hermes dropped. Tern keeps retrying; prompts you send wait for it."
    >
      <spinner key="spin" style="dots" tone="warning" />
      <text key="text" text="Reconnecting to Hermes" wrap="none" />
      <text key="attempt" spans={[{ s: 'muted', t: ` · attempt ${r.attempt} · ${waiting ? 'next try in' : 'trying now…'}` }]} wrap="none" />
      {waiting ? <elapsed age={countdownAge(r, r.dueAt, now)} format="short" key="countdown" /> : null}
    </row>
  )
}
