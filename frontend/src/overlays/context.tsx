// Read-only context snapshot. The gateway owns its counts and category estimates.
import type { SessionContextBreakdownResult, Usage } from '@hermes/shared/gateway-events'
import type { KvItem } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import { errorText } from '../core/errors.js'
import { contextCount, contextPercent, contextWindow } from '../session/context.js'
import type { SessionState } from '../session/state.js'
import { rpc } from '../wire/rpc.js'

import type { Overlay } from './overlay.js'

export type ContextHost = Pick<ChatPorts, 'changed' | 'close' | 'gw' | 'open'> & {
  readonly session: Pick<SessionState, 'ticket' | 'usage'>
}

const count = (n: number | null | undefined) => contextCount(n)?.toLocaleString() ?? 'Unknown'

export function contextFacts(usage: Usage | null): KvItem[] {
  const context = contextWindow(usage)

  return [
    { k: 'Used tokens', v: count(usage?.context_used) },
    { k: 'Context capacity', v: contextCount(usage?.context_max) ? count(usage?.context_max) : 'Unknown' },
    { k: 'Context used', v: context ? `${contextPercent(context)}%` : 'Unknown' },
    { k: 'Count type', v: usage?.context_estimated === true ? 'Estimated' : usage?.context_estimated === false ? 'Provider usage' : 'Unknown' },
    { k: 'Count source', v: usage?.context_source || 'Unknown' },
    { k: 'Compactions', v: count(usage?.compressions) },
    { k: 'Auto-compaction threshold', v: 'Unknown (not exposed by the gateway)' }
  ]
}

export function openContext(host: ContextHost) {
  const ticket = host.session.ticket()
  const initial = host.session.usage
  let breakdown: SessionContextBreakdownResult | undefined
  let status = ticket.sid ? 'Loading category estimates…' : 'No active session. Context usage is not available.'
  let closed = false

  const overlay: Overlay = {
    key: 'context',
    modal: true,
    onClose: () => { closed = true },
    node: () => (
      <overlay anchor="center" aria="Context window" head="Context window" key="context" modal role="omp.overlay.context" size="md">
        <col gap="md" key="body">
          <text key="scope" text="Read-only snapshot · reopen to refresh" tone="muted" />
          <kv items={contextFacts(breakdown ? { ...initial, ...breakdown } : initial)} key="facts" />
          <text key="status" text={status} tone="muted" />
          {breakdown?.categories.length ? (
            <table
              cols={[{ grow: 1, head: 'Category (estimated)', id: 'label' }, { head: 'Tokens', id: 'tokens' }]}
              key="categories"
              rows={breakdown.categories.map(c => ({ cells: { label: c.label, tokens: count(c.tokens) }, id: c.id }))}
            />
          ) : null}
          <text key="threshold-note" text="The meter's 60% and 85% colors are visual warnings, not compaction thresholds." tone="muted" />
          <el aria="Close context window" key="close" onClick={() => host.close(overlay)} role="omp.btn" tag="button" text="Close · Esc" />
        </col>
      </overlay>
    ),
    onKey: key => {
      if (key.name === 'escape' || key.name === 'enter' || key.name === 'q') {
        host.close(overlay)
      }

      return true
    }
  }

  host.open(overlay)

  if (ticket.sid) {
    void rpc(host.gw, 'session.context_breakdown', { session_id: ticket.sid }).then(result => {
      if (closed || ticket.signal.aborted || !ticket.isCurrent()) {
        return
      }

      breakdown = result
      status = result.categories.length ? 'Category counts are estimates, not an exact provider accounting.' : 'Category estimates are not available yet.'
      host.changed()
    }).catch(error => {
      if (!closed && !ticket.signal.aborted && ticket.isCurrent()) {
        status = `Category breakdown unavailable: ${errorText(error)}. Totals above are the last gateway usage snapshot.`
        host.changed()
      }
    })
  }
}
