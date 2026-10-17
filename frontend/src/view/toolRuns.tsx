// Runs of tool calls folded into one line that says what happened ("Ran 2 commands, read 3
// files"), like omp's read group but for every kind of step. A click unfolds the calls.
// Calls with a view of their own stay out of runs: a delegation's Task card, the todo list
// and clarify's questions.

import { type JSX, node } from '@stencil-hq/tern'

import type { Block, ToolCall } from '../model.js'

import { age, duration } from './time.js'
import { stepTitle, toolNode } from './tools.js'

/** Calls that always show on their own. */
const SOLO = new Set(['clarify', 'delegate_task', 'todo', 'todo_list'])

/** A run needs this many calls; one call stays a card. */
const MIN_RUN = 2

/** What each tool counts as, in the summary: [singular, plural, verb]. */
const KINDS: Record<string, readonly [string, string, string]> = {
  browser_click: ['page action', 'page actions', 'Took'],
  browser_navigate: ['page', 'pages', 'Opened'],
  execute_code: ['script', 'scripts', 'Ran'],
  patch: ['file', 'files', 'Edited'],
  process: ['process check', 'process checks', 'Made'],
  read_file: ['file', 'files', 'Read'],
  search_files: ['time', 'times', 'Searched'],
  skill_view: ['skill', 'skills', 'Read'],
  terminal: ['command', 'commands', 'Ran'],
  vision_analyze: ['image', 'images', 'Looked at'],
  web_extract: ['page', 'pages', 'Read'],
  web_search: ['time on the web', 'times on the web', 'Searched'],
  write_file: ['file', 'files', 'Wrote']
}

/** A run: foldable tool calls, with the reasoning between them kept in place. */
export type Run = Block[]

/** Splits a turn's blocks into single blocks and runs of foldable tool calls, in order. */
export function groupRuns(blocks: readonly Block[]): (Block | Run)[] {
  const out: (Block | Run)[] = []
  let run: Run = []

  const flush = () => {
    // Reasoning after the run's last call is not part of it.
    const tail: Block[] = []

    while (run.at(-1)?.kind === 'thinking') {
      tail.unshift(run.pop()!)
    }

    if (run.filter(b => b.kind === 'tool').length >= MIN_RUN) {
      out.push(run)
    } else {
      out.push(...run)
    }

    out.push(...tail)
    run = []
  }

  for (const b of blocks) {
    if (b.kind === 'tool' && !SOLO.has(b.call.name)) {
      run.push(b)
    } else if (b.kind === 'thinking' && run.length) {
      // Reasoning between steps belongs to the run; it would only split it.
      run.push(b)
    } else {
      flush()
      out.push(b)
    }
  }

  flush()

  return out
}

/** "Ran 2 commands, read 3 files and edited 1 file": calls counted by kind, first use first. */
export function summarize(calls: readonly ToolCall[]): string {
  const counts = new Map<string, { n: number; kind: readonly [string, string, string] }>()

  for (const c of calls) {
    const kind = KINDS[c.name] ?? ([`${c.name} call`, `${c.name} calls`, 'Made'] as const)
    const key = `${kind[2]}|${kind[0]}`
    const seen = counts.get(key) ?? { kind, n: 0 }
    seen.n++
    counts.set(key, seen)
  }

  const parts = [...counts.values()].map(({ kind: [one, many, verb], n }, i) => {
    const phrase = `${verb.toLowerCase()} ${count(n, one, many)}`

    return i === 0 ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : phrase
  })

  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '')
}

/** `2 files`; `once` and `twice` for counted times (`searched twice`). */
function count(n: number, one: string, many: string): string {
  if (one.startsWith('time')) {
    const rest = one.slice('time'.length)

    return n === 1 ? `once${rest}` : n === 2 ? `twice${rest}` : `${n} ${many}`
  }

  return `${n} ${n === 1 ? one : many}`
}

/**
 * One run as a section: the summary as its head, each call one line inside (it opens to its
 * command and output). Open while it runs, so the steps so far stay in view, with the head
 * naming the one running now; folded to the summary once it ends.
 */
export function toolRunNode(
  run: Run,
  id: string,
  now: number,
  blockNode: (b: Block) => JSX.Element
): JSX.Element {
  const calls = run.flatMap(b => (b.kind === 'tool' ? [b.call] : []))
  const live = calls.find(c => c.status === 'running')
  const failed = calls.filter(c => c.status === 'error').length
  const first = calls[0]!
  const ended = Math.max(...calls.map(c => c.startedAt + (c.duration ?? 0)))
  const key = `r${run[0]!.id}`

  const spans = live
    ? [{ t: stepTitle(live) }, ...(calls.length > 1 ? [{ s: 'muted', t: `  step ${calls.indexOf(live) + 1} of ${calls.length}` }] : [])]
    : [{ t: summarize(calls) }, ...(failed ? [{ s: 'error', t: `, ${failed} failed` }] : [])]

  return node(
    'section',
    { collapsed: !live, collapsible: true, head: `${id}.${key}.head`, key, role: 'omp.tools.run' },
    [
      <row align="center" gap="sm" key="head">
        {live ? <spinner key="mark" style="dots" tone="accent" /> : <icon key="mark" name={failed ? 'warning' : 'tools'} />}
        <text grow={1} key="label" spans={spans} wrap="none" />
        {live ? (
          <elapsed age={age(first, first.startedAt, now)} format="short" key="time" />
        ) : (
          <text key="time" spans={[{ s: 'dim', t: duration(Math.max(0, ended - first.startedAt)) }]} />
        )}
      </row>,
      ...run.map(b => (b.kind === 'tool' ? toolNode(b.call, now, { inRun: true }) : blockNode(b)))
    ]
  )
}
