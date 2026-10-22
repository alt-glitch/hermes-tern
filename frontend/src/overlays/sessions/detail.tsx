// The session picker's preview pane: where the session ran, its whole id, its first prompt and
// last reply in full, then the conversation itself (prompts and replies, each tool call one line),
// a page at a time. The pane scrolls; with the preview focused (→), ↑/↓ step through its blocks
// and stepping near the end of what is loaded reads the next page.

import type { JSX, Span } from '@stencil-hq/tern'

import { launchEnv } from '../../config/env.js'
import { optional } from '../../core/assert.js'
import { toolCallId } from '../../core/ids.js'
import { clip } from '../../core/text.js'
import { sessionLabel, type StoredSession } from '../../hermes/sessionIndex.js'
import type { PreviewRow } from '../../hermes/sessionTranscript.js'
import { ageShort, homeTilde } from '../../view/format.js'
import { hubIconOf } from '../../view/tools/registry.js'
import { facts } from '../../view/ui/facts.js'
import { stepLabel } from '../../view/workLogModel.js'

import type { Preview } from './preview.js'
import { dateOf } from './rows.js'

/** The longest message the transcript shows whole; the rest of one longer is cut. */
const MESSAGE_MAX = 6000

/** What the pane shows of one session. */
export interface DetailInput {
  session: StoredSession
  preview: Preview | undefined
  now: number
  isCurrent: boolean
  running: boolean
  /** The focused block's key, when the preview has the keys. */
  focused?: string | undefined
  /** The id was copied a moment ago. */
  copied: boolean
  /** Reads the next page (the Load more row's click). */
  more(): void
  /** Focuses block `key` (a click on it). */
  focus(key: string): void
}

/** The pane's nodes, and the keys of its blocks in order (what ↑/↓ step through). */
export interface Detail {
  nodes: JSX.Element[]
  blocks: string[]
}

/** The key of the Load more row. */
export const MORE = 'more'

export function sessionDetail(d: DetailInput): Detail {
  const { session: s, preview } = d
  const blocks: string[] = []
  const block = (key: string, children: JSX.Element | JSX.Element[], tone?: string): JSX.Element => {
    blocks.push(key)

    return (
      <col
        gap="xs"
        key={key}
        onClick={() => d.focus(key)}
        role={d.focused === key ? 'omp.picker.block.focused' : 'omp.picker.block'}
        {...optional('tone', tone)}
      >
        {children}
      </col>
    )
  }

  const ends = preview?.ends
  const failed = preview?.status === 'error'
  const first = ends?.firstPrompt || s.preview
  const reply = ends ? ends.lastReply : undefined

  const nodes: JSX.Element[] = [
    <text key="title" role="omp.picker.title" text={sessionLabel(s)} wrap="word" />,
    <kv items={facts(overview(s, d))} key="facts" />,
    <col gap="xs" key="id" role="hermes.sessions.id">
      <text key="head" spans={[{ s: 'muted', t: 'Session id' }]} />
      <text key="value" spans={[{ s: 'mono', t: s.id }]} wrap="char" />
      <text
        key="hint"
        spans={[
          { s: 'dim', t: `${s.source || 'local'} · ` },
          d.copied ? { s: 'success', t: 'Copied' } : { s: 'dim', t: '⌥C copies it' }
        ]}
      />
    </col>,
    block('first', [
      <text key="head" spans={[{ s: 'muted strong', t: 'First prompt' }]} />,
      first
        ? <md key="text" role="hermes.sessions.prompt" text={first} tone="user" />
        : <text key="text" spans={[{ s: 'dim', t: 'No prompt yet.' }]} />
    ]),
    block('last', [
      <text key="head" spans={[{ s: 'muted strong', t: 'Last reply' }]} />,
      reply
        ? <md key="text" role="hermes.sessions.reply" text={reply} />
        : <text key="text" spans={[{ s: 'dim', t: reply === undefined && !failed ? 'Loading…' : 'No reply yet.' }]} />
    ]),
    <rule key="tx" label="Conversation" />
  ]

  if (!preview || preview.status === 'loading') {
    nodes.push(<text key="loading" spans={[{ s: 'dim', t: 'Loading the conversation…' }]} />)

    return { blocks, nodes }
  }

  if (preview.status === 'error') {
    nodes.push(<text key="error" spans={[{ s: 'error', t: `Could not read this session: ${preview.error ?? 'unknown error'}` }]} wrap="word" />)

    return { blocks, nodes }
  }

  preview.rows.forEach((row, i) => nodes.push(block(`m${i}`, rowNode(row), row.kind === 'note' && row.tone === 'error' ? 'error' : undefined)))

  if (preview.loadingMore) {
    nodes.push(block(MORE, <text key="t" spans={[{ s: 'dim', t: 'Loading more…' }]} />))
  } else if (preview.error) {
    nodes.push(block(MORE, <text key="t" onClick={d.more} spans={[{ s: 'error', t: `Could not load more: ${preview.error}. ` }, { s: 'link', t: 'Retry' }]} wrap="word" />))
  } else if (preview.next !== null) {
    nodes.push(block(MORE, <text key="t" onClick={d.more} spans={[{ s: 'link', t: 'Load more' }, { s: 'dim', t: ` · ${preview.rows.length} lines so far` }]} />))
  } else {
    nodes.push(<text key="end" spans={[{ s: 'dim', t: preview.rows.length ? 'End of the conversation.' : 'No messages.' }]} />)
  }

  return { blocks, nodes }
}

function overview(s: StoredSession, d: Pick<DetailInput, 'isCurrent' | 'now' | 'running'>) {
  const status: Span[] | undefined = d.isCurrent
    ? [{ s: 'success', t: 'open here' }]
    : d.running
      ? [{ s: 'accent', t: 'running in another pane' }]
      : undefined

  return [
    ['Status', status],
    ['Folder', s.cwd && [{ s: 'mono', t: homeTilde(s.cwd, launchEnv().home) }]],
    ['Branch', s.branch && [{ s: 'mono', t: s.branch }]],
    ['Last active', `${dateOf(s.lastActive)} · ${ageShort(d.now - s.lastActive)} ago`],
    ['Started', dateOf(s.startedAt)],
    ['Messages', String(s.messages)],
    ['Model', s.model && [{ s: 'mono', t: s.model }]]
  ] as const
}

const stepLines = new WeakMap<PreviewRow, string>()

/** A tool row's line, in the work log's words ("Read src/app.ts", the command it ran). */
function stepOf(row: Extract<PreviewRow, { kind: 'tool' }>): string {
  const held = stepLines.get(row)

  if (held !== undefined) {
    return held
  }

  const line = stepLabel({
    args: row.args,
    argsText: '',
    context: '',
    id: toolCallId(row.key),
    name: row.name,
    outcome: { duration: 0, kind: 'done' },
    startedAt: 0,
    via: { kind: 'direct' }
  })

  stepLines.set(row, line)

  return line
}

function rowNode(row: PreviewRow): JSX.Element[] {
  switch (row.kind) {
    case 'user':
      return [
        <text key="who" spans={[{ s: 'strong', t: 'You' }, ...(row.steer ? [{ s: 'dim', t: ' · steer' }] : [])]} />,
        <md key="text" role="hermes.sessions.user" text={clip(row.text, { mark: 'line', max: MESSAGE_MAX })} tone="user" />
      ]
    case 'assistant':
      return [
        <text key="who" spans={[{ s: 'strong accent', t: 'Hermes' }]} />,
        <md key="text" role="hermes.sessions.reply" text={clip(row.text, { mark: 'line', max: MESSAGE_MAX })} />
      ]
    case 'tool':
      return [
        <row align="center" gap="xs" key="line" role="hermes.sessions.tool">
          <icon key="ic" name={hubIconOf(row.name)} />
          <text key="t" spans={[{ s: 'dim', t: stepOf(row) }]} truncate="end" wrap="none" />
        </row>
      ]
    case 'note':
      return [<text key="t" spans={[{ s: row.tone === 'error' ? 'error' : 'dim', t: row.text }]} wrap="word" />]
  }
}
