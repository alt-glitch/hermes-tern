// What the shared gateway says about a turn outside its stream: `status.update` lines (lifecycle,
// warnings, compaction, goal verdicts). Mirrors Hermes' ui-tui/src/app/createGatewayEventHandler.ts
// (status.update). The keyed `notification.show` notices are chrome/notices.ts.

import { lineTokens } from './hermes/compactions.js'
import type { NoticeEntry } from './model.js'

/** The working line while the context is compacted; the stream's own labels wait for the done edge. */
export const COMPACTING_LABEL = 'Compacting context…'

/** What one `status.update` does to the view. */
export interface StatusEffect {
  /** The working line's label (only while a turn runs). */
  label?: string
  /** A line for the transcript. */
  notice?: { text: string; tone: NoticeEntry['tone'] }
  /** Compaction started (true) or ended (false): the transcript's compaction rule shows it. */
  compacting?: boolean
  /** The token counts the compaction line gave. */
  tokens?: { before?: number | undefined; after?: number | undefined }
  /** The warning to pass back as `last` next time. */
  note?: string
}

/**
 * The effect of `status.update {kind, text}`. The shared gateway sends `lifecycle` (retries,
 * fallbacks), `warn`, `compacting`/`compacted` (auto-compaction) and `goal`; `last` is the warning
 * shown last, so a repeated one stays a single line.
 */
export function statusEffect(payload: { kind?: string; text?: string } | undefined, last?: string): StatusEffect {
  const text = payload?.text?.trim()
  const kind = payload?.kind ?? ''

  // /compress always ends with a bare `ready` (methods_session._compress_live's finally).
  if (!text) {
    return kind === 'ready' ? { compacting: false } : {}
  }

  if (kind === 'goal') {
    return { notice: { text, tone: text.startsWith('✓') ? 'success' : 'info' } }
  }

  if (kind === 'compacting' || kind === 'compressing') {
    return { compacting: true, label: COMPACTING_LABEL, ...counted(text) }
  }

  if (kind === 'compacted' || kind === 'ready') {
    return { compacting: false, label: text, ...counted(text) }
  }

  if (kind === 'warn' || kind === 'approval' || kind === 'error') {
    return text === last ? {} : { note: text, notice: { text, tone: kind === 'error' ? 'error' : 'warning' } }
  }

  return { label: text }
}

/** A compaction line's token counts, when it gives any. */
function counted(text: string): Pick<StatusEffect, 'tokens'> {
  const tokens = lineTokens(text)

  return tokens.before || tokens.after ? { tokens } : {}
}
