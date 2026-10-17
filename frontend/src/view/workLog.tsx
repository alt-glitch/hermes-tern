// A turn's work as t3code's timeline draws it (MessagesTimeline.tsx, WorkLog.tsx): quiet
// one-line rows, an icon column, the label in the secondary text color. A work group is a
// summary row ("Ran 3 commands") that opens to one row per step; a step opens to its output
// and a thought to its text. The group still running is a single shining line ("Running
// ls"). Tern keeps each section's open state, so a click needs no round trip.

import { type JSX, node } from '@stencil-hq/tern'

import type { TurnEntry } from '../model.js'
import {
  actionIcon,
  actionOf,
  clock,
  type Fold,
  groupIcon,
  liveLabel,
  stepLabel,
  summarize,
  thoughtLine,
  visibleItems,
  type WorkItem
} from '../workLog.js'

import { age } from './time.js'
import { toolDetail } from './tools.js'

/** "Working for 12s" over a running turn, ruled off from its steps. */
export function workingNode(turn: TurnEntry, now: number): JSX.Element {
  return (
    <row align="center" gap="xs" key="working" role="hermes.turn.working">
      <text key="label" spans={[{ s: 'muted', t: 'Working for' }]} wrap="none" />
      <elapsed age={age(turn, turn.startedAt, now)} format="short" key="age" />
    </row>
  )
}

/** "Thinking", shining, at the end of a running turn with nothing else moving. */
export function thinkingRow(): JSX.Element {
  return (
    <row align="center" gap="sm" key="thinking" role="hermes.work.row">
      <icon key="icon" name="brain" />
      <text grow={1} key="label" spans={[{ fx: 'shimmer', s: 'muted', t: 'Thinking' }]} wrap="none" />
    </row>
  )
}

/** "Worked for 54s": the finished turn's steps and notes, folded until a click. */
export function foldNode(fold: Fold, id: string, children: (JSX.Element | null)[]): JSX.Element {
  return node('section', { collapsed: true, collapsible: true, head: `${id}.fold.head`, key: 'fold', role: 'hermes.turn.fold' }, [
    <row align="center" gap="xs" key="head">
      <text key="label" spans={[{ s: 'muted', t: fold.label }]} wrap="none" />
    </row>,
    ...children
  ])
}

/**
 * One work group under `parent` (a node id): its single step as a row, or a summary row that
 * opens to every step. `live` marks the group a running turn is in now: one shining line naming
 * its latest step, which opens the same way.
 */
export function workNode(items: readonly WorkItem[], parent: string, live: boolean, now: number): JSX.Element | null {
  const shown = visibleItems(items)

  if (!shown.length) {
    return null
  }

  const key = `w${items[0]!.id}`
  const id = `${parent}.${key}`

  if (!live && shown.length === 1) {
    return itemNode(shown[0]!, parent, now, key)
  }

  const calls = shown.flatMap(i => (i.kind === 'tool' ? [i.call] : []))
  const failed = calls.at(-1)?.status === 'error'
  const latest = shown.findLast(i => i.kind === 'tool' && i.call.status === 'running') ?? shown.at(-1)!

  const head = live ? (
    <row align="center" gap="sm" key="head">
      <icon key="icon" name={itemIcon(latest)} />
      <text grow={1} key="label" spans={[{ fx: 'shimmer', s: 'muted', t: liveLabel(latest) }]} truncate="end" wrap="none" />
    </row>
  ) : (
    <row align="center" gap="sm" key="head">
      <icon key="icon" name={groupIcon(shown)} tone={failed ? 'error' : undefined} />
      <text grow={1} key="label" spans={[{ s: 'muted', t: summarize(shown) }]} truncate="end" wrap="none" />
      <text key="time" role="hermes.work.time" spans={[{ s: 'dim', t: clock(startOf(shown[0]!)) }]} wrap="none" />
    </row>
  )

  return node('section', { collapsed: true, collapsible: true, head: `${id}.head`, key, role: 'hermes.work.group' }, [
    head,
    ...shown.map(i => itemNode(i, id, now))
  ])
}

/** One step: a call (opens to its output) or a thought (opens to its text). */
function itemNode(item: WorkItem, parent: string, now: number, key = item.id): JSX.Element {
  const id = `${parent}.${key}`

  if (item.kind === 'thinking') {
    return node('section', { collapsed: true, collapsible: true, head: `${id}.head`, key, role: 'hermes.work.row' }, [
      <row align="center" gap="sm" key="head">
        <icon key="icon" name="brain" />
        <text grow={1} key="label" spans={[{ s: 'muted', t: thoughtLine(item.text) }]} truncate="end" wrap="none" />
      </row>,
      <md key="body" role="hermes.work.thought" stream={item.endedAt === undefined || undefined}>
        {item.text}
      </md>
    ])
  }

  const call = item.call
  const detail = toolDetail(call, now)
  const running = call.status === 'running'

  const head = (
    <row align="center" gap="sm" key="head" title={call.context || undefined}>
      <icon key="icon" name={itemIcon(item)} tone={call.status === 'error' ? 'error' : undefined} />
      <text
        grow={1}
        key="label"
        spans={[{ fx: running ? 'shimmer' : undefined, s: 'muted', t: stepLabel(call) }]}
        truncate="end"
        wrap="none"
      />
      {call.status === 'error' ? <icon key="failed" name="x" tone="error" /> : null}
    </row>
  )

  if (!detail.length) {
    return (
      <col key={key} role="hermes.work.row">
        {head}
      </col>
    )
  }

  return node('section', { collapsed: true, collapsible: true, head: `${id}.head`, key, role: 'hermes.work.row' }, [
    head,
    <col gap="xs" key="detail" role="hermes.work.detail">
      {detail}
    </col>
  ])
}

function itemIcon(item: WorkItem): string {
  return item.kind === 'thinking' ? 'brain' : actionIcon(actionOf(item.call))
}

const startOf = (item: WorkItem) => (item.kind === 'tool' ? item.call.startedAt : item.startedAt)
