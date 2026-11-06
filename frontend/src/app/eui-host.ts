// The composition root supplies current authority; the EUI store never imports App.
import type { EuiHostPort } from '../eui/host.js'
import type { PanelEntry } from '../model.js'
import type { SessionState } from '../session/state.js'
import type { Transcript } from '../transcript/store.js'

export function euiHostPort(host: { readonly session: SessionState; readonly transcript: Transcript }, active: () => boolean): EuiHostPort {
  return {
    active,
    owner: () => {
      const sessionId = host.session.ref.live
      if (!sessionId) return undefined
      const ticket = host.session.ownerTicket()
      const lifetime = host.transcript.lifetime
      return {
        sessionId,
        signal: ticket.signal,
        isCurrent: () => ticket.isCurrent() && host.session.ref.live === sessionId && host.transcript.lifetime === lifetime
      }
    },
    append: title => {
      const entry: PanelEntry = {
        id: host.transcript.id('eui'), kind: 'panel', title,
        text: 'This host card is no longer active. Reopen the flow to review current data.'
      }
      host.transcript.push(entry)
      return entry
    },
    contains: entry => host.transcript.entries.includes(entry)
  }
}
