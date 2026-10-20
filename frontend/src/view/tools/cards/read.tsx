// The read_file tool: omp's read card, the numbered lines it got.

import { langOf } from '../../../code/lang.js'
import type { ToolCall } from '../../../model.js'
import type { ReadDetail } from '../../../tools/files.js'
import { shortPath } from '../steps.js'
import type { Card, ToolView } from '../types.js'

/** The read_file tool's view. */
export const readView: ToolView<'read_file'> = {
  action: 'read',
  card: readCard,
  hubIcon: 'read',
  step: (_call, d) => (d.path ? `Read ${shortPath(d.path)}` : 'Read file')
}

/** The file's lines as read, numbered from where the read began; the range (or the whole count) as meta. */
function readCard(call: ToolCall, d: ReadDetail): Card {
  const path = d.path ?? call.context
  const content = d.content
  const total = d.totalLines
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
