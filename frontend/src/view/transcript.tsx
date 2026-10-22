// Transcript entries as nodes of the `main` region, in the roles Tern's chat
// styles (Reader, Spine, Console) are written against: `omp.user` cards,
// `omp.assistant` columns holding streamed `md`, work groups (workLog.tsx) and
// `tool` cards, and an `omp.turn.usage` footer.

import type { JSX } from '@stencil-hq/tern'

import { optional } from '../core/assert.js'
import type { Block, Compaction, Entry, NoticeEntry, TurnEntry, UserAttachment, UserEntry } from '../model.js'
import { steerState } from '../transcript/messages.js'
import { answerText, turnEndedAt } from '../transcript/turns.js'

import { duration } from './format.js'
import { slashBody } from './slash.js'
import { age, compact } from './time.js'
import { toolNode } from './tools/shell.js'
import { foldSection, headedCard } from './ui/fold.js'
import { shimmerText } from './ui/live.js'
import { type WelcomeContext, welcomeNode } from './welcome.js'
import { foldNode, latestFailed, thinkingRow, workingNode, workNode } from './workLog.js'
import { parts, pieces } from './workLogModel.js'

/** What entry views need from the app. */
export interface TranscriptContext {
  now: number
  welcome: WelcomeContext
  /** Copies a prompt's or an answer's text; `id` is its entry id. */
  copy(text: string, id: string): void
  /** The entry copied a moment ago, whose copy button shows a check. */
  copied?: string | undefined
}

const kNode = Symbol('tsp.node')

/** An entry carrying its last built node and the revision it was built at. */
interface Built {
  [kNode]?: { rev: string; node: JSX.Element }
}

/**
 * The node of one entry; `id` is its full node id (`main.<key>`). Turns and compactions rebuild
 * only when their `rev` moved and prompts, notices and panels never change, so a long transcript
 * costs one turn's build per frame (timer ages are fixed at first build, see time.ts).
 */
export function entryNode(e: Entry, id: string, cx: TranscriptContext): JSX.Element {
  if (e.kind === 'welcome') {
    return welcomeNode(e.id, cx.welcome)
  }

  // Entries are plain objects; the symbol slot rides on them (weak type: widen first).
  const holder: object = e
  const built: Built = holder
  const rev = `${e.kind === 'turn' || e.kind === 'compaction' ? e.rev : 0}${cx.copied === e.id ? '+copied' : ''}`
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

    case 'compaction':
      return compactionNode(e.compaction, e.id, id, cx.now)

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
      {e.attachments?.length ? attachmentsRow(e.attachments) : null}
      {e.text ? <md key="body">{e.text}</md> : null}
    </card>
  )
}

/**
 * A prompt's attachments over its words, as omp's bubble shows them: each image a thumbnail
 * (a click opens Tern's lightbox, which steps through the others), a file or a gone image a chip.
 */
function attachmentsRow(list: readonly UserAttachment[]): JSX.Element {
  return (
    <row align="start" gap="sm" key="images" role="omp.user.images" wrap>
      {list.map((a, i) =>
        a.source ? (
          <image alt={a.name} key={`a${i}`} title={a.name} {...a.source} />
        ) : (
          <row
            align="center"
            gap="xs"
            key={`a${i}`}
            role="hermes.user.attachment"
            title={a.kind === 'image' ? `${a.name} (the file is gone)` : a.name}
          >
            <icon key="i" name={a.kind === 'image' ? 'image' : 'file'} />
            <text key="t" text={a.name} truncate="middle" wrap="none" />
          </row>
        )
      )}
    </row>
  )
}

function turnNode(turn: TurnEntry, id: string, cx: TranscriptContext): JSX.Element {
  const live = turn.end.status === 'live'
  const children: (JSX.Element | null)[] = []

  // A turn Hermes started by itself gets a quiet line saying why, so it does not read as part
  // of the answer above it.
  if (turn.continued) {
    children.push(
      <row align="center" gap="sm" key="continued" role="omp.turn.continued">
        <icon key="icon" name={continuedIcon(turn.continued)} />
        <text key="why" spans={[{ s: 'muted', t: turn.continued }]} />
      </row>
    )
  }

  if (live) {
    children.push(workingNode(turn, cx.now))
  }

  // A finished turn shows its answer (and the user's steers) under "Worked for 54s"; the steps
  // and notes before them fold.
  for (const part of parts(turn)) {
    children.push(
      ...(part.kind === 'fold'
        ? [foldNode(part, `${id}.${part.key}`, pieceNodes(turn, part.blocks, `${id}.${part.key}`, cx))]
        : pieceNodes(turn, part.blocks, id, cx))
    )
  }

  // A line of background work that ended meanwhile is not the turn's newest step.
  const last = pieces(turn.blocks).findLast(p => p.kind !== 'block' || p.block.kind !== 'event')

  // t3code: once the newest step failed, its group stops shining and "Thinking" carries the turn.
  // A running compaction is its own live line.
  const compacting = last?.kind === 'block' && last.block.kind === 'compaction' && last.block.compaction.state.status === 'running'

  if (live && !compacting && (!last || (last.kind === 'block' && last.block.kind !== 'text') || (last.kind === 'work' && latestFailed(last.items)))) {
    children.push(thinkingRow())
  }

  const end = turn.end

  if (end.status === 'error') {
    children.push(
      headedCard({
        body: [
          // A failed turn reloaded from an older store knows only Hermes' advice, not the error.
          end.error ? (
            <text key="message" lines={8} role="omp.error.message" spans={[{ s: 'mono', t: end.error }]} wrap="word" />
          ) : null,
          end.hint ? <md key="hint">{end.hint}</md> : null
        ],
        head: (
          <row gap="sm" key="head">
            <text key="title" spans={[{ s: 'error strong', t: 'Request failed' }]} />
            {end.code ? <badge key="code" role="omp.error.code" text={end.code} tone="error" /> : null}
          </row>
        ),
        id: `${id}.error`,
        key: 'error',
        role: 'omp.error',
        tone: 'error'
      })
    )
  } else if (end.status === 'interrupted') {
    children.push(
      <text key="abort" role="omp.assistant.abort" spans={[{ s: 'error', t: 'Interrupted' }]} wrap="word" />
    )
  }

  if (turn.warning) {
    children.push(<text key="warning" role="omp.notice" spans={[{ s: 'warning', t: turn.warning }]} wrap="word" />)
  }

  const answer = answerText(turn)

  if (!live && turnEndedAt(turn) && (answer || turn.usage?.total || turn.tickTokens)) {
    children.push(usageNode(turn, answer, cx))
  }

  return (
    <col key={turn.id} role="omp.assistant">
      {children}
    </col>
  )
}

/**
 * `blocks` (some of the turn's) under the node `parent`, in order: text, steers and cards alone,
 * the work between them grouped. While the turn runs, its last group is the live line.
 */
function pieceNodes(turn: TurnEntry, blocks: readonly Block[], parent: string, cx: TranscriptContext): (JSX.Element | null)[] {
  const live = turn.end.status === 'live'
  const ps = pieces(blocks, turn.blocks)
  const lastText = blocks.findLast(b => b.kind === 'text')
  // The live line is the last group, past the lines of background work that ended meanwhile.
  const tail = ps.findLastIndex(p => p.kind !== 'block' || p.block.kind !== 'event')

  return ps.map((p, i) => {
    if (p.kind === 'work') {
      return workNode(p.items, parent, live && i === tail && !latestFailed(p.items), cx.now)
    }

    const b = p.block

    switch (b.kind) {
      case 'text':
        return (
          <md key={b.id} {...optional('stream', (live && b === lastText) || undefined)}>
            {b.text}
          </md>
        )

      case 'tool':
        return toolNode(b.call, cx.now)

      case 'steer':
        return steerNode(b, steerState(turn, turn.blocks.indexOf(b)))

      case 'compaction':
        return compactionNode(b.compaction, b.id, `${parent}.${b.id}`, cx.now)

      case 'event':
        return eventNode(b)

      case 'thinking':
        return null
    }
  })
}

/** The reason line's icon: agents, a background command, a watcher, or Hermes going on. */
function continuedIcon(why: string): string {
  return /^(\d+ )?subagent/i.test(why) ? 'users' : why.startsWith('Watcher') ? 'eye' : why.startsWith('Background') ? 'terminal' : 'loop'
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

function usageNode(turn: TurnEntry, answer: string, cx: TranscriptContext): JSX.Element {
  const u = turn.usage ?? {}
  const ms = (turnEndedAt(turn) ?? turn.startedAt) - turn.startedAt
  const input = u.input ?? u.prompt ?? 0
  const output = u.output ?? u.completion ?? 0
  const total = u.total || input + output || turn.tickTokens || 0
  const cost = typeof u.cost_usd === 'number' && u.cost_usd > 0 ? ` · $${u.cost_usd.toFixed(2)}` : ''
  const title = `This turn: ${duration(ms)} · ${total.toLocaleString()} tokens (${input.toLocaleString()} in · ${output.toLocaleString()} out)${cost}`

  const tps = (typeof u.avg_tps === 'number' && u.avg_tps > 0 ? u.avg_tps : undefined) ?? turn.tps
  const facts: (readonly [string, string, string])[] = total
    ? [
        ['time', 'time', duration(ms)],
        ['tokens', 'tokens', compact(total)],
        ...(turn.cacheHit !== undefined ? [['cache', 'cache', `${turn.cacheHit}%`] as const] : []),
        ...(tps ? [['speed', 'fast', `${Math.round(tps)} t/s`] as const] : []),
        ...(cost ? [['cost', 'cost', cost.replace(/^ · /, '')] as const] : [])
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
    <row align="center" gap="xs" key="usage" role="omp.turn.usage" {...optional('title', total ? detail : undefined)}>
      {answer ? copyButton(answer, turn.id, 'omp.turn.copy', 'Copy answer', cx) : null}
      {facts.flatMap(([key, icon, value]) => [
        <icon key={`${key}.icon`} name={icon} />,
        <text key={key} text={value} />
      ])}
    </row>
  )
}

const COMPACTED_TITLE =
  'Hermes summarized the conversation before this line to free context. From here on the agent works from that summary; the turns above stay here for you.'

/**
 * A compaction, as a rule across the transcript: "Compacting context" and its timer while it
 * runs, then "Context compacted" and what it freed. With its summary known, a click on the rule
 * opens the summary the agent goes on from.
 */
function compactionNode(c: Compaction, key: string, id: string, now: number): JSX.Element {
  const done = c.state.status === 'done' ? c.state : undefined
  const running = !done
  const tokens = c.before && done?.after ? `${compact(c.before)} → ${compact(done.after)} tokens` : c.before ? `${compact(c.before)} tokens` : ''
  const took = done?.endedAt && done.endedAt - c.startedAt >= 1000 ? duration(done.endedAt - c.startedAt) : ''
  const facts = !done
    ? [tokens]
    : [tokens, done.messages ? `${done.messages.toLocaleString()} messages summarized` : '', took, c.manual ? '/compress' : '']
  const detail = facts.filter(Boolean).join(' · ')

  const line = (
    <row align="center" gap="xs" key="head" role="hermes.compaction.line" {...optional('title', running ? undefined : COMPACTED_TITLE)}>
      {running ? shimmerText({ key: 'what', text: 'Compacting context' }) : <icon key="icon" name="compaction" />}
      {running ? null : <text key="what" spans={[{ s: 'muted', t: 'Context compacted' }]} wrap="none" />}
      {running ? <elapsed age={age(c, c.startedAt, now)} format="short" key="age" /> : null}
      {detail ? <text key="facts" spans={[{ s: 'dim', t: `· ${detail}` }]} truncate="end" wrap="none" /> : null}
    </row>
  )

  if (!done?.summary) {
    return (
      <col key={key} role="hermes.compaction">
        {line}
      </col>
    )
  }

  return foldSection({
    body: [
      <text key="lead" role="hermes.compaction.lead" spans={[{ s: 'dim', t: 'The summary the agent goes on from:' }]} wrap="word" />,
      <md key="summary">{done.summary}</md>
    ],
    head: line,
    id,
    key,
    role: 'hermes.compaction'
  })
}

/** Background work that ended during the turn: a dim line, its icon toned by how it ended. */
function eventNode(b: Extract<Block, { kind: 'event' }>): JSX.Element {
  const icon = b.tone === 'success' ? 'done' : b.tone === 'error' ? 'failed' : b.tone === 'warning' ? 'aborted' : 'info'

  return (
    <row align="center" gap="xs" key={b.id} role="hermes.event">
      <icon key="icon" name={icon} tone={b.tone === 'info' ? 'muted' : b.tone} />
      <text key="text" spans={[{ s: 'dim', t: b.text }]} wrap="word" />
    </row>
  )
}

function noticeNode(e: NoticeEntry): JSX.Element {
  const tone = e.tone === 'info' ? 'muted' : e.tone

  return <text key={e.id} role={`omp.notice.${e.tone}`} spans={[{ s: tone, t: e.text }]} wrap="word" />
}
