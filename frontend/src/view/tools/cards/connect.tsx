// The manage_connections tool's connect card: the apps to authorize, their states, and Continue.

import { allConnected, type ConnectTarget, connectTargets, isConnectCall, type SettleReason, waiting } from '../../../connections/cards.js'
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

/** Why a settled card stopped short of connecting every app. */
const SETTLED_NOTE: Record<SettleReason, string> = {
  all_resolved: 'All connected.',
  continued: 'Sent to Hermes.',
  deadline: 'Stopped waiting after 15 minutes. Ask Hermes to connect again.',
  error: 'Hermes stopped watching these links.',
  stopped: 'Hermes stopped watching these links. Ask Hermes to connect again.',
  superseded: 'A later request replaced this one.'
}

/**
 * The connect card `manage_connections` gets on the desktop, for its no-card result: one row per
 * app with its state and an Authorize button that opens its link, then Continue, which tells the
 * agent the user is done (the tool's own note asks it to wait for that, then check status). Settled,
 * it is the desktop's static summary: the rows as they ended, no controls.
 */
function connectCard(call: ToolCall): Card {
  const card = call.connect ?? { opened: [], targets: connectTargets(call), told: false }
  const { settled, targets } = card
  const ref = card.key ?? call.id

  // A settled card's unresolved rows did not connect (the desktop's settle).
  const stateOf = (t: ConnectTarget) =>
    settled && waiting(t) ? 'not_connected' : t.state === 'initiated' && !card.opened.includes(t.name) ? 'pending' : t.state

  const open = settled ? [] : targets.filter(waiting)

  const rows = targets.map((t, i) => {
    const look = CONNECT_STATE[stateOf(t)] ?? PENDING

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
            ...(t.detail && look.tone === 'error' ? [{ s: 'muted', t: ` · ${t.detail}` }] : [])
          ]}
          truncate="end"
          wrap="none"
        />
        {t.url && !settled && waiting(t) ? (
          <row actions={{ click: `connect-open=${ref}:${t.name}` }} align="center" gap="xs" key="go" role="hermes.connect.open" title={t.url}>
            <text key="t" text="Authorize ↗" />
          </row>
        ) : null}
      </row>
    )
  })

  const note = card.told
    ? open.length || (settled && settled !== 'all_resolved')
      ? 'Sent to Hermes.'
      : 'All connected. Hermes carries on.'
    : settled
      ? `${SETTLED_NOTE[settled]}${settled === 'error' && card.error ? ` ${card.error}` : ''}`
      : undefined

  return {
    body: [
      ...rows,
      ...(note
        ? [<text key="done" spans={[{ s: 'muted', t: note }]} wrap="word" />]
        : [
            <row align="center" gap="sm" key="foot">
              <text
                grow={1}
                key="hint"
                spans={[
                  {
                    s: 'muted',
                    t: open.length ? 'Authorize in the browser. Hermes hears when every app is connected.' : 'All set.'
                  }
                ]}
                wrap="word"
              />
              {open.length ? (
                <row actions={{ click: `connect-continue=${ref}` }} align="center" key="go" role="hermes.connect.continue">
                  <text key="t" text="Done, continue" />
                </row>
              ) : null}
            </row>
          ])
    ],
    name: 'plug',
    target: `${targets.filter(t => t.state === 'connected').length} of ${targets.filter(t => t.state !== 'superseded').length} connected`,
    targetKind: 'text',
    title: allConnected(card) ? 'Apps connected' : 'Connect apps'
  }
}
