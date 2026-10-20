// The search_files tool: omp's glob card (file names) and grep card (matches by file).

import type { JSX } from '@stencil-hq/tern'

import { langOf } from '../../../code/lang.js'
import type { ToolCall } from '../../../model.js'
import { record } from '../../../wire/json.js'
import { nonEmpty, plural } from '../../format.js'
import type { Card } from '../types.js'

/** A file search as the files it found; a content search as its matches, grouped by file. */
export function searchCard(call: ToolCall, result: Record<string, unknown> | undefined): Card {
  const pattern = nonEmpty(call.args.pattern) ?? call.context
  const where = nonEmpty(call.args.path)
  const inPath = where && where !== '.' ? ` · in ${where}` : ''
  const files = Array.isArray(result?.files) ? result.files.map(f => nonEmpty(f)).filter(f => f !== undefined) : undefined

  if (files || call.args.target === 'files') {
    const list = (files ?? []).map(f => f.replace(/^\.\//, ''))
    const total = typeof result?.total_count === 'number' ? result.total_count : list.length

    return {
      body: list.slice(0, 200).map((f, i) => {
        const slash = f.lastIndexOf('/')

        return (
          <row key={`f${i}`} role="omp.tool.file" title={slash > 0 ? f.slice(0, slash + 1) : undefined}>
            <text key="p" spans={[{ s: 'path', t: slash > 0 ? f.slice(slash + 1) : f }]} />
          </row>
        )
      }),
      folded: list.length > 20,
      frame: 'inline',
      meta: files ? [`${plural(total, 'file')}${inPath}`] : undefined,
      name: 'glob',
      target: pattern,
      targetKind: 'pattern',
      title: 'Glob'
    }
  }

  const matches = Array.isArray(result?.matches)
    ? result.matches.map(m => record(m)).filter(m => m !== undefined)
    : undefined

  const byFile = new Map<string, { line: number; text: string }[]>()

  for (const m of matches ?? []) {
    const path = (nonEmpty(m.path) ?? '').replace(/^\.\//, '')
    const list = byFile.get(path) ?? []
    list.push({ line: typeof m.line === 'number' ? m.line : 0, text: typeof m.content === 'string' ? m.content : '' })
    byFile.set(path, list)
  }

  const total = typeof result?.total_count === 'number' ? result.total_count : (matches?.length ?? 0)
  const body: JSX.Element[] = []
  let fileIndex = 0

  for (const [path, hits] of byFile) {
    const f = `f${fileIndex++}`
    body.push(
      <row key={f} role="omp.tool.file">
        <text key="p" spans={[{ s: 'path', t: path }]} />
        <text key="n" role="omp.tool.chip" spans={[{ t: String(hits.length) }]} />
      </row>
    )

    // Consecutive lines share one numbered block; gaps show omp's `…` row.
    let run: { line: number; text: string }[] = []
    let runIndex = 0

    const flush = () => {
      const start = run[0]?.line ?? 1

      if (runIndex > 0) {
        body.push(<text key={`${f}.g${runIndex}`} role="omp.tool.context" spans={[{ s: 'muted', t: '…' }]} />)
      }

      body.push(
        <code
          key={`${f}.c${runIndex++}`}
          lang={langOf(path)}
          marks={run.map(h => ({ line: h.line, tone: 'accent' }))}
          numbers
          start={start}
          text={run.map(h => h.text).join('\n')}
        />
      )
      run = []
    }

    for (const hit of hits) {
      if (run.length && hit.line !== (run.at(-1)?.line ?? 0) + 1) {
        flush()
      }

      run.push(hit)
    }

    if (run.length) {
      flush()
    }
  }

  return {
    body,
    folded: total > 40,
    frame: 'inline',
    meta: matches
      ? [`${plural(total, 'match', 'matches')} · ${plural(byFile.size, 'file')}${inPath}`]
      : undefined,
    name: 'grep',
    target: pattern,
    targetKind: 'pattern',
    title: 'Grep'
  }
}
