// Transcript entries as nodes of the `main` region, in the roles Tern's chat
// styles (Reader, Spine, Console) are written against: `omp.user` cards,
// `omp.assistant` columns holding streamed `md`, work groups (workLog.tsx) and
// `tool` cards, and an `omp.turn.usage` footer.

import type { JSX } from '@stencil-hq/tern'

import { displayMarkdown, type FileContext } from '../artifacts/links.js'
import { optional } from '../core/assert.js'
import type { MediaDelivery } from '../media-delivery.js'
import type { SessionIds } from '../core/ids.js'
import type { Block, Compaction, Entry, NoticeEntry, TurnEntry, UserAttachment, UserEntry } from '../model.js'
import { steerState } from '../transcript/messages.js'
import type { EuiCards } from '../eui/cards.js'
import type { TableCharts } from '../transcript/tableCharts.js'
import { answerText, turnEndedAt } from '../transcript/turns.js'

import { euiCardNode } from './euiCard.js'
import { duration } from './format.js'
import { attachmentImagePath, imagePreviewNode } from './media.js'
import { slashBody } from './slash.js'
import { age, compact } from './time.js'
import type { BrowserFocus } from './tools/cards/browser.js'
import type { LspLinkContext } from './tools/lsp-links.js'
import { toolNode } from './tools/shell.js'
import { foldSection, headedCard } from './ui/fold.js'
import { shimmerText } from './ui/live.js'
import { type WelcomeContext, welcomeNode } from './welcome.js'
import { foldNode, latestFailed, thinkingRow, workingNode, workNode } from './workLog.js'
import { parts, pieces } from './workLogModel.js'

/** What entry views need from the app. */
export interface TranscriptContext {
  /** Presentation-only, session-scoped Markdown table charts. */
  charts?: TableCharts
  /** Demo fences plus separately registered, session-owned host panels. */
  eui?: EuiCards
  now: number
  /** Negotiated Tern clock preference; older hosts default to 24-hour time. */
  hour12?: boolean
  /** Supplied by live frames; omitted by historical consumers of the view helper. */
  links?: FileContext
  /** SDK actions bound to the session instance that rendered this entry. */
  focusBrowser?: BrowserFocus | undefined
  /** The exact instance whose SDK handlers are cached with this entry. */
  browserSource?: Pick<SessionIds, 'live'> | undefined
  welcome: WelcomeContext
  /** File-host evidence from the current frame, never a replayed tool result. */
  lspContext?: LspLinkContext
  /** Copies a prompt's or an answer's text; `id` is its entry id. */
  copy(text: string, id: string): void
  /** The entry copied a moment ago, whose copy button shows a check. */
  copied?: string | undefined
  /** Optional for isolated render fixtures; App supplies its current delivery service. */
  media?: MediaDelivery
  mediaRev?: string
}

const kNode = Symbol('tsp.node')

/** Release a cold entry's JSX and handler closures without changing Hermes history. */
export function forgetEntryNode(entry: Entry): void {
  const holder: object = entry
  const built: Built = holder
  delete built[kNode]
}

/** An entry carrying its last built node and the revision it was built at. */
interface Built {
  [kNode]?: { rev: string; browserSource?: Pick<SessionIds, 'live'> | undefined; node: JSX.Element }
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
  // Authority is presentation state: a cached local href must not survive a host/cwd switch.
  const rev = JSON.stringify([e.kind === 'turn' || e.kind === 'compaction' ? e.rev : 0,
    cx.copied === e.id, e.kind === 'user' ? (cx.hour12 ?? false) : null, cx.lspContext?.hostLocal === true, cx.lspContext?.cwd ?? '', cx.charts?.revision ?? 0, cx.eui?.revision ?? 0, cx.mediaRev ?? '', cx.links?.cwd ?? '', cx.links?.hostLocal ?? false, cx.links?.media ?? false])
  const cached = built[kNode]

  if (cached?.rev === rev && cached.browserSource === cx.browserSource) {
    return cached.node
  }

  const node = buildEntry(e, id, cx)
  built[kNode] = { browserSource: cx.browserSource, node, rev }

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

    case 'panel': {
      const hosted = cx.eui?.hostView(e)
      if (hosted && cx.eui) return <col key={e.id} role="eui.host-panel">{euiCardNode(id + '.host', hosted, cx.eui)}</col>
      return (
        <card collapsible head={[{ s: 'strong', t: e.title }]} key={e.id} role="omp.custom" tone="neutral">
          {slashBody(e)}
        </card>
      )
    }
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
          spans={[{ s: 'dim mono', t: at.toLocaleTimeString([], { hour: '2-digit', hour12: cx.hour12 ?? false, minute: '2-digit' }) }]}
          title={at.toLocaleString([], { hour12: cx.hour12 ?? false })}
        />
        {copyButton(e.text, e.id, 'omp.user.tool', 'Copy message', cx)}
      </row>
      {e.attachments?.length ? attachmentsRow(e.attachments, cx) : null}
      {e.text ? <md key="body">{e.text}</md> : null}
    </card>
  )
}

/**
 * A prompt's attachments over its words, as omp's bubble shows them: each image a thumbnail
 * (a click opens Tern's lightbox, which steps through the others), a file or a gone image a chip.
 */
function attachmentsRow(list: readonly UserAttachment[], cx: TranscriptContext): JSX.Element {
  return (
    <row align="start" gap="sm" key="images" role="omp.user.images" wrap>
      {list.map((a, i) => {
        const path = a.source && 'blob' in a.source ? undefined
          : a.refPath ?? (a.source && 'path' in a.source ? a.source.path : undefined)
        const remote = a.kind === 'image' && path && cx.media && !cx.media.context().local
          ? attachmentImagePath(path, cx.media)
          : undefined

        return remote && cx.media ? imagePreviewNode(remote, cx.media, a.name, `a${i}`)
          : a.source && ('blob' in a.source || !cx.media || cx.media.context().local) ? (
            <image alt={a.name} key={`a${i}`} title={a.name} {...a.source} />
          ) : (
          <row
            align="center"
            gap="xs"
            key={`a${i}`}
            role="hermes.user.attachment"
            title={a.kind === 'image'
              ? `${a.name} (${cx.media && !cx.media.context().local ? 'remote preview unavailable' : 'the file is gone'})`
              : a.name}
          >
            <icon key="i" name={a.kind === 'image' ? 'image' : 'file'} />
            <text key="t" text={a.name} truncate="middle" wrap="none" />
          </row>
        )
      })}
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

  const last = pieces(turn.blocks).at(-1)

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

  return ps.map((p, i) => {
    if (p.kind === 'work') {
      return workNode(p.items, parent, live && i === ps.length - 1 && !latestFailed(p.items), cx.now, cx.lspContext, cx.focusBrowser, cx.media, cx.links)
    }

    const b = p.block

    switch (b.kind) {
      case 'text': {
        const cards = cx.eui?.split(b.text, `${parent}.${b.id}`)

        if (cx.eui && cards && cards.some(c => c.kind !== 'md')) {
          return euiAnswerNode(b.id, cards, cx.eui)
        }

        return (
          <md key={b.id} {...optional('stream', (live && b === lastText) || undefined)}>
            {live ? b.text : displayMarkdown(cx.charts?.markdown(b.text, turn.end.status === 'done') ?? b.text, cx.links?.hostLocal ? cx.links.cwd : '')}
          </md>
        )
      }

      case 'tool':
        return toolNode(b.call, cx.now, cx.lspContext, cx.focusBrowser, cx.media, cx.links)

      case 'steer':
        return steerNode(b, steerState(turn, turn.blocks.indexOf(b)))

      case 'compaction':
        return compactionNode(b.compaction, b.id, `${parent}.${b.id}`, cx.now)

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

function noticeNode(e: NoticeEntry): JSX.Element {
  const tone = e.tone === 'info' ? 'muted' : e.tone

  return <text key={e.id} role={`omp.notice.${e.tone}`} spans={[{ s: tone, t: e.text }]} wrap="word" />
}

/** An answer with `ephemeral-ui` fences: its Markdown around each card, in order. */
function euiAnswerNode(id: string, parts: ReturnType<EuiCards['split']>, eui: EuiCards): JSX.Element {
  return (
    <col key={id} role="eui.answer">
      {parts.map((p, i) => p.kind === 'card'
        ? euiCardNode(p.key, eui.view(p.key, p.spec), eui)
        : p.kind === 'bad'
          ? <col key={`bad${i}`} role="eui.card.invalid"><text key="e" role="eui.error" text={`ephemeral-ui card not drawn: ${p.error}`} /><md key="src">{p.text}</md></col>
          : <md key={`md${i}`}>{p.text}</md>)}
    </col>
  )
}
