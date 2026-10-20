// The read_file tool: omp's read card, the numbered lines it got.

import { langOf } from '../../../code/lang.js'
import type { ToolCall } from '../../../model.js'
import { nonEmpty } from '../../format.js'
import type { Card } from '../types.js'

/** The file's lines as read, numbered from where the read began; the range (or the whole count) as meta. */
export function readCard(call: ToolCall, result: Record<string, unknown> | undefined): Card {
  const path = nonEmpty(call.args.path) ?? call.context
  const content = nonEmpty(result?.content)
  const total = typeof result?.total_lines === 'number' ? result.total_lines : undefined
  const numbered = content ? [...content.matchAll(/^ *(\d+)\|/gm)] : []
  const first = numbered.length ? Number(numbered[0]?.[1]) : undefined
  const last = numbered.length ? Number(numbered.at(-1)?.[1]) : undefined
  const whole = first === 1 && last !== undefined && last === total
  const meta = first !== undefined && last !== undefined ? [whole ? `${total} lines` : `:${first}-${last}`] : []

  return {
    body: content
      ? [<code key="code" lang={langOf(path)} numbers start={first} text={content.replace(/^ *\d+\|/gm, '')} />]
      : [],
    folded: true,
    frame: 'inline',
    meta,
    name: 'read',
    target: path,
    targetKind: 'path',
    title: 'Read'
  }
}
