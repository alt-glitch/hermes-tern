// `/compress` on the shared gateway: `session.mutate operation=compress` (its slash.exec refuses
// the command). Ported from Hermes' ui-tui/src/app/slash/canonicalSessionControls.ts
// (mutateCanonicalSession's payload, printCompressSummary).
import type { NoticeEntry } from '../model.js'

import type { MutationResult } from './mutate.js'

/**
 * The mutation's payload: the raw argument as `focus`, which the gateway parses as every native
 * /compress does (`--preview`, `here [N]`, or a focus topic).
 */
export function compressPayload(arg: string): Record<string, string> {
  const focus = arg.trim()

  return focus ? { focus } : {}
}

interface CompressSummary {
  headline?: string
  noop?: boolean
  note?: string
  token_line?: string
}

/** What a compress result says: a `--preview` report, or its summary lines; `committed` when the history changed. */
export interface CompressReport {
  committed: boolean
  preview?: string
  lines: { text: string; tone: NoticeEntry['tone'] }[]
}

export function compressReport(result: MutationResult): CompressReport {
  if (result.status === 'preview') {
    const lines = Array.isArray(result.lines) ? result.lines.filter(l => typeof l === 'string') : []

    return { committed: false, lines: [], preview: lines.join('\n') }
  }

  const summary = (result.summary ?? null) as CompressSummary | null
  const noop = result.status === 'noop' || Boolean(summary?.noop)
  const headline = summary?.headline
    ? { text: `${noop ? '' : '✓ '}${summary.headline}`, tone: noop ? ('info' as const) : ('success' as const) }
    : { text: '✓ Transcript compressed', tone: 'success' as const }

  return {
    committed: result.status !== 'noop',
    lines: [
      headline,
      ...[summary?.token_line, summary?.note]
        .filter((line): line is string => Boolean(line))
        .map(text => ({ text: `  ${text}`, tone: 'info' as const }))
    ]
  }
}
