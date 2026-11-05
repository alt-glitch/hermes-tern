// Read-only /info sheet: current gateway session identity, inventory and usage, plus context estimates.
import type { SessionContextBreakdownResult, Usage } from '@hermes/shared/gateway-events'
import type { KvItem } from '@stencil-hq/tern'
import type { SessionInfo } from '@tui/types.js'

import type { ChatPorts } from '../app/ports.js'
import { errorText } from '../core/errors.js'
import { contextCount, contextWindow } from '../session/context.js'
import { actionsRow } from '../view/ui/button.js'
import { rpc } from '../wire/rpc.js'

import { contextFacts } from './context.js'
import { nativeOverlayKey } from './identity.js'
import type { Overlay } from './overlay.js'

export type SessionInfoHost = Pick<ChatPorts, 'changed' | 'close' | 'gw' | 'open' | 'session'>

const known = (s: string | null | undefined): string => s?.trim() || 'Unknown'
const count = (n: number | null | undefined): string => contextCount(n)?.toLocaleString() ?? 'Unknown'

/** The session.info event owns these fields; a stored id is shown separately from its live id. */
export function sessionInfoFacts(info: SessionInfo | null, sid: string | null): KvItem[] {
  return [
    { k: 'Title', v: known(info?.title) },
    { k: 'Session ID', v: known(info?.stored_session_id || sid) },
    ...(info?.stored_session_id && sid && info.stored_session_id !== sid ? [{ k: 'Live session ID', v: sid }] : []),
    { k: 'Profile', v: known(info?.profile_name) },
    { k: 'Working directory', v: known(info?.cwd) },
    { k: 'Model', v: known(info?.model) },
    { k: 'Provider', v: known(info?.provider) }
  ]
}

/** Available tools are inventory, not a count of tools actually invoked. */
export function sessionStatFacts(info: SessionInfo | null, usage: Usage | null): KvItem[] {
  const tools = info?.tools

  return [
    { k: 'Available tools', v: tools ? count(new Set(Object.values(tools).flat()).size) : 'Unknown' },
    { k: 'Tool groups', v: tools ? count(Object.keys(tools).length) : 'Unknown' },
    { k: 'Input tokens', v: count(usage?.input) },
    { k: 'Output tokens', v: count(usage?.output) },
    { k: 'Reasoning tokens', v: count(usage?.reasoning) },
    { k: 'Total tokens', v: count(usage?.total) },
    { k: 'Model API calls', v: count(usage?.calls) },
    { k: 'Cache-read tokens', v: count(usage?.cache_read) },
    { k: 'Cache-write tokens', v: count(usage?.cache_write) }
  ]
}

/** /info opens a snapshot; a late RPC may update only its original live session and overlay. */
export function openSessionInfo(host: SessionInfoHost): void {
  const sid = host.session.ref.live
  const owner = host.session.ownerTicket?.()
  const info = host.session.info
  const initial = host.session.usage ?? info?.usage ?? null
  let usage = initial
  let breakdown: SessionContextBreakdownResult | undefined
  let status = sid ? 'Loading category estimates…' : 'No active session. Session information is not available.'
  let closed = false

  const overlay: Overlay = {
    key: 'session-info',
    modal: true,
    onClose: () => { closed = true },
    node: id => (
      <overlay anchor="center" aria="Session info" head="Session info" key={nativeOverlayKey(id)} modal role="omp.overlay.sessionInfo" size="lg">
        <col gap="md" key="body">
          <text key="scope" text="Read-only snapshot · reopen to refresh" tone="muted" />
          <section head="Session" key="identity" role="omp.info.session">
            <kv items={sessionInfoFacts(info, sid)} key="facts" />
          </section>
          <section head="Context" key="context" role="omp.info.context">
            <kv items={contextFacts(usage, breakdown?.categories.length ? breakdown.estimated_total : undefined)} key="facts" />
            {breakdown?.categories.length ? (
              <table
                cols={[{ grow: 1, head: 'Category (estimated)', id: 'label' }, { head: 'Tokens', id: 'tokens' }]}
                key="categories"
                rows={breakdown.categories.map(c => ({ cells: { label: c.label, tokens: count(c.tokens) }, id: c.id }))}
              />
            ) : null}
          </section>
          <section head="Tools and tokens" key="stats" role="omp.info.stats">
            <text key="scope" text="Gateway inventory and session counters, not tool invocations" tone="muted" />
            <kv items={sessionStatFacts(info, usage)} key="facts" />
          </section>
          <text key="status" text={status} tone="muted" />
          {actionsRow([{ key: 'close', label: 'Close', keys: ['escape'], onClick: () => host.close(overlay) }])}
        </col>
      </overlay>
    ),
    onKey: key => {
      if (key.name === 'escape') host.close(overlay)

      return true
    }
  }

  host.open(overlay)

  if (sid) {
    void rpc(host.gw, 'session.context_breakdown', { session_id: sid }).then(result => {
      if (closed || host.session.ref.live !== sid || owner?.signal.aborted || (owner && !owner.isCurrent())) return

      breakdown = result
      if (result.categories.length && contextWindow(result)) {
        usage = { ...initial, ...result }
      }
      status = result.categories.length
        ? 'Category rows are local estimates and need not sum to Used tokens.'
        : 'Category estimates are not available yet.'
      host.changed()
    }).catch(error => {
      if (!closed && host.session.ref.live === sid && !owner?.signal.aborted && (!owner || owner.isCurrent())) {
        status = 'Category breakdown unavailable: ' + errorText(error) + '. Session usage above is still available.'
        host.changed()
      }
    })
  }
}
