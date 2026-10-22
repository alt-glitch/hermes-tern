// The manage_connections tool's connect card: the apps to authorize, their states, and Continue.

import {
  allConnected,
  cardRef,
  type ConnectCard,
  type ConnectTarget,
  connectTargets,
  isConnectCall,
  type SettleReason,
  unresolved,
  waiting
} from '../../../connections/cards.js'
import { verbOf } from '../../../connections/live.js'
import { optional } from '../../../core/assert.js'
import type { ToolCall } from '../../../model.js'
import { namedStep } from '../steps.js'
import type { Card, ToolView } from '../types.js'

import { genericCard, humanize } from './generic.js'

/** The manage_connections tool's view: the connect card while it has apps to authorize, else the generic card. */
export const connectView: ToolView<'manage_connections'> = {
  action: 'other',
  card: (call, d) => (isConnectCall(call) ? connectCard(call) : genericCard(call, d, { name: call.name, title: humanize(call.name) })),
  step: namedStep
}

interface ConnectLook {
  icon: string
  tone?: 'error' | 'muted' | 'pending' | 'success'
  word: string
}

/** Minted, not opened yet: the desktop's waiting cue belongs to a row the user opened. */
const PENDING: ConnectLook = { icon: 'clock', tone: 'muted', word: 'needs authorizing' }

const CONNECT_STATE: Record<string, ConnectLook> = {
  connected: { icon: 'check', tone: 'success', word: 'connected' },
  expired: { icon: 'clock', tone: 'error', word: 'link expired' },
  failed: { icon: 'x', tone: 'error', word: 'failed' },
  initiated: { icon: 'clock', tone: 'pending', word: 'waiting for your browser' },
  not_connected: { icon: 'minus', tone: 'muted', word: 'not connected' },
  pending: PENDING,
  skipped: { icon: 'minus', tone: 'muted', word: 'skipped' },
  superseded: { icon: 'minus', tone: 'muted', word: 'asked again below' }
}

/** An MCP row the gateway is installing or enabling, with no link for the user (yet). */
const WORKING: ConnectLook = { icon: 'clock', tone: 'pending', word: 'setting up' }

/** Why a settled card stopped short of connecting every app. */
const SETTLED_NOTE: Record<SettleReason, string> = {
  all_resolved: 'All connected.',
  continued: 'Sent to Hermes.',
  deadline: 'Stopped waiting after 15 minutes. Ask Hermes to connect again.',
  error: 'Hermes stopped watching these links.',
  interrupt: 'The turn was stopped before every app connected.',
  stopped: 'Hermes stopped watching these links. Ask Hermes to connect again.',
  superseded: 'A later request replaced this one.'
}

/** A clickable word on a row (`gap`) or the card's foot. */
function button(key: string, act: string, label: string, role: string, { gap, title }: { gap?: 'xs'; title?: string | undefined } = { gap: 'xs' }) {
  return (
    <row key={key} actions={{ click: act }} align="center" {...optional('gap', gap)} role={role} {...optional('title', title)}>
      <text key="t" text={label} />
    </row>
  )
}

/** A row's buttons: the file path's Authorize, or the gateway's verb (Authorize, Connect, Try again) and Skip. */
function rowButtons(card: ConnectCard, ref: string, t: ConnectTarget) {
  if (card.settled) {
    return []
  }

  const row = `${ref}:${t.name}`

  if (!card.op) {
    return t.url && waiting(t) ? [button('go', `connect-open=${row}`, 'Authorize ↗', 'hermes.connect.open', { gap: 'xs', title: t.url })] : []
  }

  const verb = verbOf(t)

  return [
    ...(verb === 'open' && t.url ? [button('go', `connect-open=${row}`, 'Authorize ↗', 'hermes.connect.open', { gap: 'xs', title: t.url })] : []),
    ...(verb === 'approve' ? [button('go', `connect-approve=${row}`, 'Connect', 'hermes.connect.approve')] : []),
    ...(verb === 'retry' ? [button('go', `connect-retry=${row}`, 'Try again', 'hermes.connect.retry')] : []),
    ...(unresolved(t) ? [button('skip', `connect-skip=${row}`, 'Skip', 'hermes.connect.skip')] : [])
  ]
}

/** The card's last line once nothing waits on the user, or undefined while something does. */
function noteOf(card: ConnectCard, open: readonly ConnectTarget[]): string | undefined {
  const { settled } = card

  if (card.told) {
    return open.length || (settled && settled !== 'all_resolved') ? 'Sent to Hermes.' : 'All connected. Hermes carries on.'
  }

  if (!settled) {
    return undefined
  }

  if (card.op) {
    // The tool returned with the rows as they ended; Hermes reads them itself.
    if (settled === 'all_resolved' || settled === 'continued') {
      return allConnected(card) ? 'All connected.' : 'Hermes carries on.'
    }

    return settled === 'deadline' ? 'Hermes stopped waiting. Ask it to connect again.' : SETTLED_NOTE[settled]
  }

  return `${SETTLED_NOTE[settled]}${settled === 'error' && card.error ? ` ${card.error}` : ''}`
}

/** The foot's hint while apps wait: what to do, and how long the gateway waits for a live card. */
function hintOf(card: ConnectCard, open: readonly ConnectTarget[]): string {
  if (!open.length) {
    return 'All set.'
  }

  if (card.op) {
    const minutes = Math.max(1, Math.round(card.op.timeoutSeconds / 60))

    return `Authorize in the browser, or skip. Hermes waits for every app, up to ${minutes} minute${minutes === 1 ? '' : 's'}.`
  }

  return 'Authorize in the browser. Hermes hears when every app is connected.'
}

/**
 * The connect card `manage_connections` gets on the desktop: one row per app with its state and its
 * button (Authorize opens its link; on a live card also Connect, Try again and Skip), then Continue.
 * On a live card Continue ends the tool's wait; on a card file it tells the agent the user is done
 * (the tool's note asks it to wait for that, then check status). Settled, it is the desktop's
 * static summary: the rows as they ended, no controls.
 */
function connectCard(call: ToolCall): Card {
  const card = call.connect ?? { opened: [], targets: connectTargets(call), told: false }
  const { settled, targets } = card
  const ref = cardRef(call)

  // A settled card's unresolved rows did not connect (the desktop's settle).
  const stateOf = (t: ConnectTarget) =>
    settled && waiting(t) ? 'not_connected' : t.state === 'initiated' && t.url && !card.opened.includes(t.name) ? 'pending' : t.state

  const lookOf = (t: ConnectTarget) => (!settled && t.state === 'initiated' && !t.url ? WORKING : (CONNECT_STATE[stateOf(t)] ?? PENDING))
  const open = settled ? [] : targets.filter(card.op ? unresolved : waiting)

  const rows = targets.map((t, i) => {
    const look = lookOf(t)
    const needs = !settled && t.needs ? [{ s: 'muted', t: ` · needs ${t.needs.join(', ')}: set it up in Hermes Desktop` }] : []

    return (
      <row align="center" gap="sm" key={`t${i}`} role="hermes.connect.row">
        <icon key="i" name={look.icon} {...optional('tone', look.tone)} />
        <text
          grow={1}
          key="n"
          spans={[
            { s: 'strong', t: t.title },
            ...(t.alias ? [{ s: 'muted', t: ` (${t.alias})` }] : []),
            { s: look.tone ?? 'muted', t: `  ${look.word}` },
            ...(t.detail && look.tone === 'error' ? [{ s: 'muted', t: ` · ${t.detail}` }] : []),
            ...needs
          ]}
          truncate="end"
          wrap="none"
        />
        {rowButtons(card, ref, t)}
      </row>
    )
  })

  const note = noteOf(card, open)

  return {
    body: [
      ...rows,
      ...(note
        ? [<text key="done" spans={[{ s: 'muted', t: note }]} wrap="word" />]
        : [
            <row align="center" gap="sm" key="foot">
              <text grow={1} key="hint" spans={[{ s: 'muted', t: hintOf(card, open) }]} wrap="word" />
              {open.length ? button('go', `connect-continue=${ref}`, 'Done, continue', 'hermes.connect.continue', {}) : null}
            </row>
          ])
    ],
    name: 'plug',
    target: `${targets.filter(t => t.state === 'connected').length} of ${targets.filter(t => t.state !== 'superseded').length} connected`,
    targetKind: 'text',
    title: allConnected(card) ? 'Apps connected' : 'Connect apps'
  }
}
