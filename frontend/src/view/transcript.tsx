// Transcript entries as nodes of the `main` region, in the roles Tern's chat
// styles (Reader, Spine, Console) are written against: `omp.user` cards,
// `omp.assistant` columns holding `omp.thinking` sections, streamed `md` and
// `tool` nodes, and an `omp.turn.usage` footer.

import { type JSX, node } from '@stencil-hq/tern'

import type { Block, Entry, NoticeEntry, TurnEntry, UserEntry } from '../model.js'

import { age, compact, duration } from './time.js'
import { toolNode } from './tools.js'
import { type WelcomeContext, welcomeNode } from './welcome.js'

/** What entry views need from the app. */
export interface TranscriptContext {
  now: number
  welcome: WelcomeContext
  copy(text: string): void
}

const kNode = Symbol('tsp.node')

/** An entry carrying its last built node and the revision it was built at. */
interface Built {
  [kNode]?: { rev: number; node: JSX.Element }
}

/**
 * The node of one entry; `id` is its full node id (`main.<key>`). Turns rebuild only when
 * their `rev` moved and prompts, notices and panels never change, so a long transcript
 * costs one turn's build per frame (timer ages are fixed at first build, see time.ts).
 */
export function entryNode(e: Entry, id: string, cx: TranscriptContext): JSX.Element {
  if (e.kind === 'welcome') {
    return welcomeNode(e.id, cx.welcome)
  }

  // Entries are plain objects; the symbol slot rides on them (weak type: widen first).
  const holder: object = e
  const built: Built = holder
  const rev = e.kind === 'turn' ? e.rev : 0
  const cached = built[kNode]

  if (cached?.rev === rev) {
    return cached.node
  }

  const node = buildEntry(e, id, cx)
  built[kNode] = { node, rev }

  return node
}

function buildEntry(e: Exclude<Entry, { kind: 'welcome' }>, id: string, cx: TranscriptContext): JSX.Element {
  switch (e.kind) {
    case 'user':
      return userNode(e, cx)

    case 'turn':
      return turnNode(e, id, cx)

    case 'notice':
      return noticeNode(e)

    case 'panel':
      return (
        <card collapsible head={[{ s: 'strong', t: e.title }]} key={e.id} role="omp.custom" tone="neutral">
          <md key="body">{e.text}</md>
        </card>
      )
  }
}

function userNode(e: UserEntry, cx: TranscriptContext): JSX.Element {
  const at = new Date(e.at || Date.now())

  return (
    <card key={e.id} role="omp.user" tone="user">
      <row gap="xs" key="tools" role="omp.user.tools">
        <text
          key="time"
          role="omp.user.time"
          spans={[{ s: 'dim mono', t: at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }]}
          title={at.toLocaleString()}
        />
        <text key="copy" onClick={() => cx.copy(e.text)} role="omp.user.tool" text="Copy" title="Copy message" />
      </row>
      <md key="body">{e.text}</md>
    </card>
  )
}

function turnNode(turn: TurnEntry, id: string, cx: TranscriptContext): JSX.Element {
  const live = turn.status === 'live'
  const lastText = turn.blocks.findLast(b => b.kind === 'text')
  const children = turn.blocks.map(b => blockNode(b, `${id}.${b.id}`, live && b === lastText, cx))

  if (turn.status === 'error') {
    children.push(
      node('card', { head: `${id}.error.head`, key: 'error', role: 'omp.error', tone: 'error' }, [
        <row gap="sm" key="head">
          <text key="title" spans={[{ s: 'error strong', t: 'Request failed' }]} />
          {turn.errorCode ? <badge key="code" role="omp.error.code" text={turn.errorCode} tone="error" /> : null}
        </row>,
        <text
          key="message"
          lines={8}
          role="omp.error.message"
          spans={[{ s: 'mono', t: turn.error ?? '' }]}
          wrap="word"
        />,
        turn.errorHint ? <md key="hint">{turn.errorHint}</md> : null
      ])
    )
  } else if (turn.status === 'interrupted') {
    children.push(
      <text key="abort" role="omp.assistant.abort" spans={[{ s: 'error', t: 'Interrupted' }]} wrap="word" />
    )
  }

  if (turn.warning) {
    children.push(<text key="warning" role="omp.notice" spans={[{ s: 'warning', t: turn.warning }]} wrap="word" />)
  }

  if (!live && turn.endedAt && (turn.usage?.total || turn.usage?.input || turn.usage?.output)) {
    children.push(usageNode(turn))
  }

  return (
    <col key={turn.id} role="omp.assistant">
      {children}
    </col>
  )
}

function blockNode(b: Block, id: string, streaming: boolean, cx: TranscriptContext): JSX.Element {
  switch (b.kind) {
    case 'text':
      return (
        <md key={b.id} stream={streaming || undefined}>
          {b.text}
        </md>
      )

    case 'tool':
      return toolNode(b.call, cx.now)

    case 'thinking':
      return thinkingNode(b, id, cx)
  }
}

function thinkingNode(b: Extract<Block, { kind: 'thinking' }>, id: string, cx: TranscriptContext): JSX.Element {
  const head = `${id}.head`

  if (b.endedAt === undefined) {
    return (
      <section collapsed={false} collapsible head={head} key={b.id} role="omp.thinking.live">
        <row gap="sm" key="head">
          <spinner key="spin" role="omp.thinking.spin" style="starburst" />
          <text key="label" spans={[{ s: 'muted', t: 'Thinking…' }]} />
          <elapsed age={age(b, b.startedAt, cx.now)} format="short" key="age" />
        </row>
        <md key="body" stream>
          {b.text}
        </md>
      </section>
    )
  }

  const took = b.endedAt - b.startedAt

  // `took` isn't a typed section prop: Tern reads it on `omp.thinking` to
  // chain consecutive thoughts into one "Thought for Ns" disclosure.
  return node(
    'section',
    { collapsed: true, collapsible: true, head, key: b.id, role: 'omp.thinking', took: took > 0 ? took : undefined },
    [
      <text key="head" spans={[{ s: 'muted', t: took >= 1000 ? `Thought for ${duration(took)}` : 'Thought' }]} />,
      <md key="body">{b.text}</md>
    ]
  )
}

function usageNode(turn: TurnEntry): JSX.Element {
  const u = turn.usage ?? {}
  const ms = (turn.endedAt ?? turn.startedAt) - turn.startedAt
  const input = u.input ?? u.prompt ?? 0
  const output = u.output ?? u.completion ?? 0
  const total = u.total ?? input + output
  const cost = typeof u.cost_usd === 'number' && u.cost_usd > 0 ? ` · $${u.cost_usd.toFixed(2)}` : ''
  const title = `This turn: ${duration(ms)} · ${total.toLocaleString()} tokens (${input.toLocaleString()} in · ${output.toLocaleString()} out)${cost}`

  return (
    <row align="center" gap="xs" key="usage" role="omp.turn.usage" title={title}>
      <icon key="icon" name="time" />
      <text key="text">{`${duration(ms)} · ${compact(total)} tok${cost} this turn`}</text>
    </row>
  )
}

function noticeNode(e: NoticeEntry): JSX.Element {
  const tone = e.tone === 'info' ? 'muted' : e.tone

  return <text key={e.id} role={`omp.notice.${e.tone}`} spans={[{ s: tone, t: e.text }]} wrap="word" />
}
