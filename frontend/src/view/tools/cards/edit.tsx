// The patch and write_file tools: omp's edit card (a diff) and write card (a new file, whole).

import { diffStats, hunks, plainDiff } from '../../../code/diff.js'
import { langOf } from '../../../code/lang.js'
import type { ToolCall } from '../../../model.js'
import type { EditDetail } from '../../../tools/files.js'
import { plural } from '../../format.js'
import { shortPath } from '../steps.js'
import type { Card, ToolView } from '../types.js'

/** The patch tool's view. */
export const patchView: ToolView<'patch'> = {
  action: 'edit',
  card: editCard,
  hubIcon: 'edit',
  step: (_call, d) => (d.path ? `Edited ${shortPath(d.path)}` : 'Edited a file')
}

/** The write_file tool's view. */
export const writeView: ToolView<'write_file'> = {
  action: 'edit',
  card: editCard,
  hubIcon: 'write',
  step: (_call, d) => (d.path ? `Wrote ${shortPath(d.path)}` : 'Wrote a file')
}

/** An edit's diff with its +/− counts; a new file as the file itself, numbered. */
function editCard(call: ToolCall, d: EditDetail): Card {
  const path = d.path ?? call.context
  const lang = langOf(path)
  const diff = hunks(d.diff) ?? (call.diff ? plainDiff(call.diff) : undefined)
  const content = d.content
  const write = d.tool === 'write_file'

  const head = {
    name: write ? 'write' : 'edit',
    target: path,
    targetKind: 'path',
    title: write ? 'Write' : 'Edit'
  } satisfies Partial<Card>

  // A new file is all additions: omp shows it as the file, numbered, with a badge.
  if (write && content && (!diff || diff.startsWith('@@ -0,0 '))) {
    const text = content.replace(/\n$/, '')
    const lines = text.split('\n').length

    return {
      ...head,
      badges: diff ? [{ text: 'new file', tone: 'success' }] : undefined,
      body: [<code key="code" lang={lang ?? 'text'} numbers text={text} />],
      folded: true,
      meta: [plural(lines, 'line')],
      preview: { lines: 8 }
    }
  }

  if (!diff) {
    return { ...head, body: [] }
  }

  const { added, removed } = diffStats(diff)

  return { ...head, body: [<diff key="diff" lang={lang} text={diff} />], meta: [`+${added} −${removed}`] }
}
