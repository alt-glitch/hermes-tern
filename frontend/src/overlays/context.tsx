// Read-only context snapshot. The gateway owns its counts and category estimates.
import type { SessionContextBreakdownResult, Usage } from '@hermes/shared/gateway-events'
import type { KvItem } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import { errorText } from '../core/errors.js'
import { contextCount, contextPercent, contextWindow } from '../session/context.js'
import type { SessionState } from '../session/state.js'
import { actionsRow } from '../view/ui/button.js'
import { rpc } from '../wire/rpc.js'

import type { Overlay } from './overlay.js'

export type ContextHost = Pick<ChatPorts, 'changed' | 'close' | 'gw' | 'open'> & {
  readonly session: Pick<SessionState, 'ticket' | 'usage'>
}

const count = (n: number | null | undefined) => contextCount(n)?.toLocaleString() ?? 'Unknown'

function contextSource(source: string | null | undefined): string {
  switch (source) {
    case 'provider_usage': return 'Provider-reported'
    case 'provider_usage_plus_estimate': return 'Provider + estimate since last reply'
    case 'local_estimate':
    case 'estimate': return 'Local estimate'
    default: return source || 'Unknown'
  }
}

export function contextFacts(usage: Usage | null, estimatedTotal?: number): KvItem[] {
  const context = contextWindow(usage)

  return [
    { k: 'Used tokens', v: count(usage?.context_used) },
    { k: 'Context capacity', v: contextCount(usage?.context_max) ? count(usage?.context_max) : 'Unknown' },
    { k: 'Context used', v: context ? `${contextPercent(context)}%` : 'Unknown' },
    { k: 'Count source', v: contextSource(usage?.context_source) },
    { k: 'Compactions', v: count(usage?.compressions) },
    ...(estimatedTotal === undefined ? [] : [{ k: 'Estimated total (categories)', v: count(estimatedTotal) }])
  ]
}

export function openContext(host: ContextHost) {
  const ticket = host.session.ticket()
  const initial = host.session.usage
  let usage = initial
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
          <kv items={contextFacts(usage, breakdown?.categories.length ? breakdown.estimated_total : undefined)} key="facts" />
          <text key="status" text={status} tone="muted" />
          {breakdown?.categories.length ? (
            <table
              cols={[{ grow: 1, head: 'Category (estimated)', id: 'label' }, { head: 'Tokens', id: 'tokens' }]}
              key="categories"
              rows={breakdown.categories.map(c => ({ cells: { label: c.label, tokens: count(c.tokens) }, id: c.id }))}
            />
          ) : null}
          {actionsRow([{ key: 'close', label: 'Close', keys: ['escape'], onClick: () => host.close(overlay) }])}
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
      if (result.categories.length && contextWindow(result)) {
        usage = { ...initial, ...result }
      }
      status = result.categories.length ? 'Category rows are local estimates and need not sum to Used tokens.' : 'Category estimates are not available yet.'
      host.changed()
    }).catch(error => {
      if (!closed && !ticket.signal.aborted && ticket.isCurrent()) {
        status = `Category breakdown unavailable: ${errorText(error)}. Totals above are the last gateway usage snapshot.`
        host.changed()
      }
    })
  }
}
