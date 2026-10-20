// The patch and write_file tools: omp's edit card (a diff) and write card (a new file, whole).

import { diffStats, hunks, plainDiff } from '../../../code/diff.js'
import { langOf } from '../../../code/lang.js'
import type { ToolCall } from '../../../model.js'
import { nonEmpty, plural } from '../../format.js'
import type { Card } from '../types.js'

/** An edit's diff with its +/− counts; a new file as the file itself, numbered. */
export function editCard(call: ToolCall, result: Record<string, unknown> | undefined): Card {
  const path = nonEmpty(call.args.path) ?? call.context
  const lang = langOf(path)
  const diff = hunks(nonEmpty(result?.diff)) ?? (call.diff ? plainDiff(call.diff) : undefined)
  const content = nonEmpty(call.args.content)
  const write = call.name === 'write_file'

  const head = {
    name: write ? 'write' : 'edit',
    target: path,
    targetKind: 'path' as const,
    title: write ? 'Write' : 'Edit'
  }

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
