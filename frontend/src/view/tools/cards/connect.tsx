// The manage_connections tool's connect card, after Hermes Desktop's (connector-tool.tsx,
// connector-card.tsx): one row per app with its mark, its state and at most one verb (Authorize,
// Connect, Try again), Not now while the app is still open, and Continue at the foot. Settled, it
// is a static summary: the rows as they ended, no controls, and a line only when the wait ended
// without the user (the deadline, a stopped turn, a link nobody watches).

import type { JSX } from '@stencil-hq/tern'

import {
  allConnected,
  cardRef,
  type ConnectCard,
  connectCardOf,
  type ConnectTarget,
  CONTINUE,
  type LiveOp,
  sendingVerb,
  type SettleReason,
  unresolved,
  waiting
} from '../../../connections/cards.js'
import { minutesLeft, verbOf } from '../../../connections/live.js'
import { optional } from '../../../core/assert.js'
import type { ToolCall } from '../../../model.js'
import { namedStep } from '../steps.js'
import type { Card, ToolView } from '../types.js'

import { genericCard, humanize } from './generic.js'

/** The manage_connections tool's view: the connect card when the call has apps to show, else the generic card. */
export const connectView: ToolView<'manage_connections'> = {
  action: 'other',
  card: (call, d, now) => {
    const card = connectCardOf(call)

    return card ? connectCard(call, card, now) : genericCard(call, d, { name: call.name, title: humanize(call.name) })
  },
  step: namedStep
}

type Tone = 'error' | 'muted' | 'pending' | 'success'

/** A row's mark (an icon, or a spinner while the gateway or the browser works) and its state word. */
interface Look {
  mark: { icon: string; tone: Tone } | 'spinner'
  tone: Tone
  word: string
}

const look = (icon: string, tone: Tone, word: string): Look => ({ mark: { icon, tone }, tone, word })

/** A link minted, not opened yet: the desktop's waiting cue belongs to a row the user opened. */
const NEEDS = look('pending', 'muted', 'needs authorizing')
const BROWSER: Look = { mark: 'spinner', tone: 'pending', word: 'waiting for your browser…' }
/** An MCP row the gateway is installing or enabling, with no link for the user (yet). */
const SETTING_UP: Look = { mark: 'spinner', tone: 'pending', word: 'setting up…' }
const NOT_CONNECTED = look('minus', 'muted', 'not connected')

const STATE: Record<string, Look> = {
  connected: look('check', 'success', 'connected'),
  expired: look('clock', 'error', 'link expired'),
  failed: look('x', 'error', 'failed'),
  not_connected: NOT_CONNECTED,
  skipped: look('minus', 'muted', 'skipped'),
  superseded: look('minus', 'muted', 'asked again below')
}

/** What a row shows: as it ended once the card settled (an open row did not connect), else its live state. */
function lookOf(card: ConnectCard, t: ConnectTarget): Look {
  if (card.settled && waiting(t)) {
    return NOT_CONNECTED
  }

  if (t.state === 'pending' || t.state === 'initiated') {
    if (!t.url) {
      return t.state === 'initiated' ? SETTING_UP : NOT_CONNECTED
    }

    return card.opened.includes(t.name) ? BROWSER : NEEDS
  }

  return STATE[t.state] ?? NOT_CONNECTED
}

/** The line under a settled card: why the gateway's wait ended without the user; none when every app resolved or the user pressed Continue. */
const NOTE: Partial<Record<SettleReason, string>> = {
  deadline: 'Hermes stopped waiting. Ask it to connect again.',
  interrupt: 'The turn stopped before every app connected.',
  stopped: 'Hermes stopped watching these links.'
}

/** A button: a verb (`go`), the quiet Not now (`quiet`), Continue (`foot`), or an answer in flight (no action). */
function button(key: string, label: string, role: string, act?: string, title?: string): JSX.Element {
  return (
    <row align="center" key={key} {...optional('actions', act ? { click: act } : undefined)} role={act ? role : 'hermes.connect.busy'} {...optional('title', title)}>
      <text key="t" text={label} wrap="none" />
    </row>
  )
}

/** What a row's answer in flight says, by the verb that sent it. */
const SENDING: Record<string, string> = { approve: 'Connecting…', retry: 'Retrying…', skip: 'Skipping…' }

/** A row's controls: its verb (Authorize, Connect, Try again) and Not now; one busy word while an answer is in flight. */
function rowButtons(card: ConnectCard, ref: string, t: ConnectTarget): JSX.Element[] {
  if (card.settled || !card.op) {
    return []
  }

  const row = `${ref}:${t.name}`
  const open = (label: string) => button('go', label, 'hermes.connect.open', `connect-open=${row}`, t.url)
  const verb = verbOf(t)
  const sending = sendingVerb(card, t.name)

  if (sending) {
    return [button('busy', SENDING[sending] ?? 'Sending…', '')]
  }

  return [
    ...(verb === 'open' && t.url ? [open(card.opened.includes(t.name) ? 'Open again ↗' : 'Authorize ↗')] : []),
    ...(verb === 'approve' ? [button('go', 'Connect', 'hermes.connect.approve', `connect-approve=${row}`)] : []),
    ...(verb === 'retry' ? [button('go', 'Try again', 'hermes.connect.retry', `connect-retry=${row}`)] : []),
    ...(unresolved(t) ? [button('skip', 'Not now', 'hermes.connect.skip', `connect-skip=${row}`)] : [])
  ]
}

/** The foot's hint while apps wait: what to do, and how much longer the gateway waits. */
function hintOf(card: ConnectCard, op: LiveOp, now: number): string {
  const minutes = minutesLeft(op, now)
  const authorize = card.targets.some(t => verbOf(t) === 'open' && t.url) ? 'Authorize in your browser. ' : ''

  return `${authorize}Hermes waits up to ${minutes} more minute${minutes === 1 ? '' : 's'}.`
}

/**
 * What approving an MCP row runs or contacts, under the row until it resolves (Desktop's
 * mcp-setup-tool.tsx): the gateway's scrubbed line in full, so the user sees what they consent to.
 */
function launchNode(card: ConnectCard, t: ConnectTarget, i: number): JSX.Element | null {
  const l = t.launch

  if (!l || card.settled || !unresolved(t)) {
    return null
  }

  const lines = [l.kind === 'stdio' ? `Runs: ${l.target}` : `Connects to: ${l.target}`, ...(l.cwd ? [`Working dir: ${l.cwd}`] : []), ...(l.env ? [`Env: ${l.env.join(', ')}`] : [])]

  return (
    <row key={`l${i}`} role="hermes.connect.launch">
      <text grow={1} key="t" spans={[{ s: 'mono muted', t: lines.join('\n') }]} wrap="word" />
    </row>
  )
}

/** One app's row: its mark, its name (and account), its state and why it failed, and its controls. */
function rowNode(card: ConnectCard, ref: string, t: ConnectTarget, i: number): JSX.Element {
  const l = lookOf(card, t)
  const live = !card.settled
  const why = live && t.detail && l.tone === 'error' ? [{ s: 'muted', t: ` · ${t.detail}` }] : []
  const needs = live && t.needs ? [{ s: 'muted', t: ` · needs ${t.needs.join(', ')}: set it up in Hermes Desktop` }] : []

  return (
    <row align="center" gap="sm" key={`t${i}`} role="hermes.connect.row">
      {l.mark === 'spinner' ? <spinner key="i" style="dots" tone="accent" /> : <icon key="i" name={l.mark.icon} tone={l.mark.tone} />}
      <text
        grow={1}
        key="n"
        spans={[
          { s: 'strong', t: t.title },
          ...(t.alias ? [{ s: 'muted', t: ` (${t.alias})` }] : []),
          { s: l.tone, t: `  ${l.word}` },
          ...why,
          ...needs
        ]}
        truncate="end"
        wrap="none"
      />
      {rowButtons(card, ref, t)}
    </row>
  )
}

/** The connect card `manage_connections` gets on the desktop; Continue ends the tool's wait. */
function connectCard(call: ToolCall, card: ConnectCard, now: number): Card {
  const { targets } = card
  const ref = cardRef(call)
  const own = targets.filter(t => t.state !== 'superseded')
  // A settled card, or a summary read back from the result, waits on nothing.
  const op = card.settled ? undefined : card.op
  const open = op ? targets.filter(unresolved) : []
  const note = card.settled && NOTE[card.settled]
  const continuing = card.sending?.includes(CONTINUE)

  const foot = op && open.length ? (
    <row align="center" gap="sm" key="foot" role="hermes.connect.foot">
      <text grow={1} key="hint" spans={[{ s: 'muted', t: hintOf(card, op, now) }]} wrap="word" />
      {continuing ? button('go', 'Continuing…', '') : button('go', 'Continue', 'hermes.connect.continue', `connect-continue=${ref}`)}
    </row>
  ) : note ? (
    <text key="note" role="hermes.connect.note" spans={[{ s: 'muted', t: note }]} wrap="word" />
  ) : null

  return {
    body: [...targets.flatMap((t, i) => [rowNode(card, ref, t, i), launchNode(card, t, i)].filter(n => n !== null)), ...(foot ? [foot] : [])],
    name: 'plug',
    // One app names itself on its row; several get a count.
    target: own.length > 1 ? `${own.filter(t => t.state === 'connected').length} of ${own.length} connected` : undefined,
    targetKind: 'text',
    title: allConnected(card) ? (own.length > 1 ? 'Apps connected' : 'App connected') : own.length > 1 ? 'Connect apps' : 'Connect an app'
  }
}
