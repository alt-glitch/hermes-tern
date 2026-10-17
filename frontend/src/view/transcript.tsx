// Transcript entries as nodes of the `main` region, in the roles Tern's chat
// styles (Reader, Spine, Console) are written against: `omp.user` cards,
// `omp.assistant` columns holding `omp.thinking` sections, streamed `md` and
// `tool` nodes, and an `omp.turn.usage` footer.

import { type JSX, node } from '@stencil-hq/tern'

import type { Block, Entry, NoticeEntry, TurnEntry, UserEntry } from '../model.js'
import { steerState } from '../transcript.js'

import { age, compact, duration } from './time.js'
import { groupRuns, toolRunNode } from './toolRuns.js'
import { slashBody } from './slash.js'
import { toolNode } from './tools.js'
import { type WelcomeContext, welcomeNode } from './welcome.js'

/** What entry views need from the app. */
export interface TranscriptContext {
  now: number
  welcome: WelcomeContext
  /** Copies a prompt's or an answer's text; `id` is its entry id. */
  copy(text: string, id: string): void
  /** The entry copied a moment ago, whose copy button shows a check. */
  copied?: string
}

const kNode = Symbol('tsp.node')

/** An entry carrying its last built node and the revision it was built at. */
interface Built {
  [kNode]?: { rev: string; node: JSX.Element }
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
  const rev = `${e.kind === 'turn' ? e.rev : 0}${cx.copied === e.id ? '+copied' : ''}`
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
          {slashBody(e)}
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
        {copyButton(e.text, e.id, 'omp.user.tool', 'Copy message', cx)}
      </row>
      <md key="body">{e.text}</md>
    </card>
  )
}

function turnNode(turn: TurnEntry, id: string, cx: TranscriptContext): JSX.Element {
  const live = turn.status === 'live'
  const lastText = turn.blocks.findLast(b => b.kind === 'text')
  const children = groupRuns(turn.blocks).map(b =>
    Array.isArray(b)
      ? toolRunNode(b, id, cx.now, inner => blockNode(inner, `${id}.r${b[0]!.id}.${inner.id}`, false, cx))
      : b.kind === 'steer'
        ? steerNode(b, steerState(turn, turn.blocks.indexOf(b)))
        : blockNode(b, `${id}.${b.id}`, live && b === lastText, cx)
  )

  // A turn Hermes started by itself gets a quiet line saying why, so it does not read as part
  // of the answer above it.
  if (turn.continued) {
    children.unshift(
      <row align="center" gap="sm" key="continued" role="omp.turn.continued">
        <icon key="icon" name={continuedIcon(turn.continued)} />
        <text key="why" spans={[{ s: 'muted', t: turn.continued }]} />
      </row>
    )
  }

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

  const answer = answerText(turn)

  if (!live && turn.endedAt && (answer || turn.usage?.total || turn.tickTokens)) {
    children.push(usageNode(turn, answer, cx))
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

    case 'steer':
      return steerNode(b, 'landed')
  }
}

/** The reason line's icon: agents, a background command, a watcher, or Hermes going on. */
function continuedIcon(why: string): string {
  return why.startsWith('Subagents') ? 'users' : why.startsWith('Watcher') ? 'eye' : why.startsWith('Background') ? 'terminal' : 'loop'
}

const STEER_NOTE = { landed: '', next: ' · sent as the next prompt', pending: ' · reaches Hermes after this step' }

/** A steer, where it joined the turn: the user's words as a small bubble, and whether it landed. */
function steerNode(b: Extract<Block, { kind: 'steer' }>, state: keyof typeof STEER_NOTE): JSX.Element {
  return (
    <card key={b.id} role="omp.user" tone="user">
      <md key="body">{b.text}</md>
      <row align="center" gap="xs" key="how" role="omp.user.steered">
        <icon key="icon" name="corner-down-right" />
        <text key="state" spans={[{ s: 'dim', t: `Steered${STEER_NOTE[state]}` }]} />
      </row>
    </card>
  )
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

/**
 * A copy button as omp's: an `icon` in a role Tern draws as a 24px hover button (`omp.user.tool`
 * under a prompt, `omp.turn.copy` under an answer), a check for a moment after a click.
 */
function copyButton(text: string, id: string, role: string, title: string, cx: TranscriptContext): JSX.Element {
  const copied = cx.copied === id

  return (
    <icon
      key="copy"
      name={copied ? 'check' : 'copy'}
      onClick={() => cx.copy(text, id)}
      role={role}
      title={copied ? 'Copied' : title}
    />
  )
}

/** The answer's text blocks, as one Markdown document. */
function answerText(turn: TurnEntry): string {
  return turn.blocks
    .flatMap(b => (b.kind === 'text' && b.text.trim() ? [b.text.trim()] : []))
    .join('\n\n')
}

function usageNode(turn: TurnEntry, answer: string, cx: TranscriptContext): JSX.Element {
  const u = turn.usage ?? {}
  const ms = (turn.endedAt ?? turn.startedAt) - turn.startedAt
  const input = u.input ?? u.prompt ?? 0
  const output = u.output ?? u.completion ?? 0
  const total = u.total || input + output || turn.tickTokens || 0
  const cost = typeof u.cost_usd === 'number' && u.cost_usd > 0 ? ` · $${u.cost_usd.toFixed(2)}` : ''
  const title = `This turn: ${duration(ms)} · ${total.toLocaleString()} tokens (${input.toLocaleString()} in · ${output.toLocaleString()} out)${cost}`

  const tps = (typeof u.avg_tps === 'number' && u.avg_tps > 0 ? u.avg_tps : undefined) ?? turn.tps
  const facts: [string, string, string][] = total
    ? [
        ['time', 'time', duration(ms)],
        ['tokens', 'tokens', compact(total)],
        ...(turn.cacheHit !== undefined ? [['cache', 'cache', `${turn.cacheHit}%`] as [string, string, string]] : []),
        ...(tps ? [['speed', 'fast', `${Math.round(tps)} t/s`] as [string, string, string]] : []),
        ...(cost ? [['cost', 'cost', cost.replace(/^ · /, '')] as [string, string, string]] : [])
      ]
    : []
  const detail = [
    title,
    turn.cacheHit !== undefined ? `${turn.cacheHit}% of the prompt came from the cache` : '',
    tps ? `${tps.toFixed(1)} tokens per second (recent calls)` : ''
  ]
    .filter(Boolean)
    .join('\n')

  // Each fact its own icon and value, in a fixed order: time, tokens, cache, speed, cost.
  return (
    <row align="center" gap="xs" key="usage" role="omp.turn.usage" title={total ? detail : undefined}>
      {answer ? copyButton(answer, turn.id, 'omp.turn.copy', 'Copy answer', cx) : null}
      {facts.flatMap(([key, icon, value]) => [
        <icon key={`${key}.icon`} name={icon} />,
        <text key={key} text={value} />
      ])}
    </row>
  )
}

function noticeNode(e: NoticeEntry): JSX.Element {
  const tone = e.tone === 'info' ? 'muted' : e.tone

  return <text key={e.id} role={`omp.notice.${e.tone}`} spans={[{ s: tone, t: e.text }]} wrap="word" />
}
