// The `dock` region: the working row while a turn runs, queued prompts, and
// the glass composer (omp.editor) with its model chip, effort, context
// hairline and session cost. Roles match omp's so Tern's composer sheets apply.

import type { EditEvent, JSX, SendEvent, Tone } from '@stencil-hq/tern'

import type { Composer } from '../composer.js'
import type { Pill } from '../chrome/hud.js'
import type { ImageSource, Todo } from '../model.js'
import { DEFAULT_EFFORT, effortText } from '../session/effort.js'
import { type ChartEntry, glance, glanceSpans, hovercard, latest, miniSpark, summary } from '../processes/widgets/view.js'
import { COMPACTING_LABEL } from '../status.js'
import { todoProgress } from '../transcript/todos.js'

import { type AutomationLine, automationNode, type Reconnecting, reconnectNode } from './automation.js'
import { plural } from './format.js'
import { type QueuedRow, queuedNode } from './queued.js'
import { compact } from './time.js'
import { checklistNode } from './todos.js'
import { workingRow } from './ui/live.js'
import { pill } from './ui/pill.js'

/** What the dock shows. */
export interface DockContext {
  composer: Composer
  /** The `editor` node's full id, for the caret overlay and focus. */
  inputId: string
  placeholder: string
  /** The agent accepts prompts (for Tern's `send`). */
  ready: boolean
  busy?: { since: object; startedAt: number; label: string }
  /** A compaction runs with no turn (/compress): the working row says so, with nothing to stop. */
  compacting?: { since: object; startedAt: number }
  queued: readonly QueuedRow[]
  model: string
  /** The session runs on a priority tier: a bolt on the model chip. */
  fast?: 'fast' | 'ultrafast'
  /** Hermes's reasoning effort (`none` = off); empty is the default level, shown muted. */
  effort: string
  /** The level the route really sends, when it clamps the pick (`ultra` → `max`). */
  effortWire?: string
  /** False for a model without reasoning: no effort chip. */
  reasons?: boolean
  /** Working directory, already shortened for display. */
  cwd: string
  branch: string
  context?: { used: number; max: number }
  cost?: number
  ghost?: string
  now: number
  onInterrupt(): void
  onSubmit(): void
  /** Tern submitted text into the composer (`send` feature). */
  onSend(ev: SendEvent): void
  /** Native editing: Tern replaced a range of the composer's text. */
  onEdit(ev: EditEvent): void
  onUndo(): void
  onModel(): void
  onEffort(): void
  /** The effort pill's context menu, by action: choose a level, save the current one as the default. */
  onEffortMenu?: Record<string, () => void>
  /** Pull the queued prompt at `index` back into the composer. */
  onQueueEdit(index: number): void
  /** Inject the queued prompt at `index` into the running turn; absent when no turn runs. */
  onQueueSteer?(index: number): void
  /** The session's cache hit (percent) and recent tokens per second, when known. */
  rates?: { cache?: number; tps?: number }
  /** Running subagents: the pill above the composer that opens the agents hub. */
  agents?: { running: number; onOpen(): void }
  /** Background processes: the shells pill that opens the Background sheet. */
  shells?: ShellsPill
  /** The conversation's pull requests: the PR pill that opens the Pull requests sheet. */
  prs?: PrsPill
  /** The agent's todo list: its pill (on the working line while a turn runs) and the panel it opens. */
  todos?: TodosPill
  /** The status strip under the composer. */
  status?: StatusLine
  /** Images the next prompt carries, as chips in the composer: a thumbnail (a click opens it large) and a remove button. */
  attachments?: ComposerImage[]
  /** The pill holding the keyboard (Down from an empty prompt). */
  focused?: Pill
  /** The standing goal and loop: one line above the pills. */
  automation?: AutomationLine
  /** The gateway is being redialled. */
  reconnecting?: Reconnecting
}

/** An image attached to the draft. */
export interface ComposerImage {
  label: string
  /** Its size, under the name. */
  caption?: string
  /** The thumbnail; unset where Tern can be sent no blob and the file is not here. */
  image?: ImageSource
  /** Still read or uploaded: the chip says so. */
  pending?: boolean
  onRemove(): void
}

/** The agent's todo list as a pill: a ring that fills as items are done, and the one under way. */
export interface TodosPill {
  list: Todo[]
  open: boolean
  onToggle(): void
}

/** The flat strip under the composer: where the session is and what it has spent. */
export interface StatusLine {
  title?: string
  tokens?: number
  /** Context used, 0–1. */
  context?: number
  /** Times the context was compressed this session (Ink's `cmp N`). */
  compressions?: number
  /** The gateway's newest out-of-band notice (credits, a slow start), in its tone. */
  notice?: { text: string; tone: 'error' | 'info' | 'success' | 'warning' }
}

/** The PR pill: the newest linked PR, or how many there are, toned by their checks. */
export interface PrsPill {
  text: string
  tone: Tone
  onOpen(): void
}

/** The shells pill: how many run, else how the recently exited ones ended. */
export interface ShellsPill {
  /** The running processes' charts: the freshest one's glance on the pill, all of them in its hover card. */
  charts?: ChartEntry[]
  running: number
  /** Exited within the retention window; shown only while none runs. */
  exited: number
  /** The newest exit's tone (success, error, warning). */
  tone: Tone
  onOpen(): void
}

/** The `dock` region's nodes: the working row, the queued prompts and the composer. */
export function dockNodes(cx: DockContext): JSX.Element[] {
  const nodes: JSX.Element[] = []

  if (cx.busy || cx.compacting) {
    nodes.push(
      <col key="hud" role="omp.hud.status">
        {cx.busy ? workingNode(cx) : compactingNode(cx.compacting!, cx.now)}
      </col>
    )
  }

  if (cx.queued.length) {
    nodes.push(queuedNode(cx.queued, { edit: cx.onQueueEdit, steer: cx.onQueueSteer }))
  }

  if (cx.todos?.open) {
    nodes.push(
      <col key="todos" role="hermes.todos">
        {checklistNode(cx.todos.list)}
      </col>
    )
  }

  const reconnect = reconnectNode(cx.reconnecting, cx.now)

  if (reconnect) {
    nodes.push(reconnect)
  }

  const automation = automationNode(cx.automation, cx.now, cx.focused)

  if (automation) {
    nodes.push(automation)
  }

  const pills = [
    // While a turn runs the todo pill rides the working line instead.
    cx.todos && !cx.busy ? todosPillNode(cx.todos, cx.focused === 'todos') : null,
    cx.agents?.running ? agentsPill(cx.agents.running, cx.agents.onOpen, cx.focused === 'agents') : null,
    cx.shells && (cx.shells.running || cx.shells.exited) ? shellsPill(cx.shells, cx.focused === 'shells') : null,
    cx.prs ? prsPillNode(cx.prs, cx.focused === 'prs') : null
  ].filter(p => p !== null)

  if (pills.length) {
    nodes.push(
      <row key="agents" role="omp.hud">
        {cx.focused ? hudHint() : null}
        {pills}
      </row>
    )
  }

  nodes.push(composerNode(cx))
  nodes.push(statusLine(cx))

  return nodes
}

/** The todo pill: a ring that fills as items are done, `2/5`, and the item under way. */
function todosPillNode(t: TodosPill, focused: boolean): JSX.Element | null {
  const { current, done, total } = todoProgress(t.list)

  if (!total) {
    return null
  }

  const finished = done === total

  return pill({
    children: [
      <meter key="ring" size="sm" style="ring" value={done / total} />,
      <text key="count" spans={[{ s: 'muted', t: 'todos ' }, { t: `${done}/${total}` }, { s: 'muted', t: ' · ' }]} wrap="none" />,
      <text
        key="now"
        role="hermes.todos.now"
        spans={[{ s: finished ? 'success' : undefined, t: finished ? 'all done' : current }]}
        truncate="end"
        wrap="none"
      />
    ],
    focused,
    key: 'todos',
    onClick: t.onToggle,
    seg: 'hermes.todos.pill',
    title: t.open ? 'Hide the todo list' : 'Show the todo list'
  })
}

/**
 * The flat strip under everything (hermes-for-tern's console bar): the brand, the session's title
 * and branch on the left; tokens, context, cache, speed, cost and the send or stop key on the right.
 */
function statusLine(cx: DockContext): JSX.Element {
  const s = cx.status ?? {}
  const context = s.context ?? (cx.context && cx.context.max > 0 ? cx.context.used / cx.context.max : undefined)

  return (
    <status key="statusline" role="hermes.statusline">
      <seg key="brand" priority={9} role="hermes.statusline.brand" spans={[{ t: '☤ hermes' }]} />
      {s.title ? <seg key="title" priority={3} spans={[{ t: s.title }]} title={s.title} /> : null}
      {s.notice ? (
        <seg
          key="notice"
          priority={6}
          role={s.notice.tone === 'info' ? undefined : `hermes.statusline.${s.notice.tone === 'warning' ? 'warn' : s.notice.tone === 'error' ? 'bad' : 'good'}`}
          spans={[{ t: s.notice.text }]}
          title={s.notice.text}
        />
      ) : null}
      {cx.branch ? (
        <seg icon="git-branch" key="git" priority={4} spans={[{ s: 'statusLineGitClean', t: cx.branch }]} title={`Branch ${cx.branch}`} />
      ) : null}
      {s.tokens ? <seg key="tokens" priority={2} side="right" spans={[{ t: `${s.tokens.toLocaleString()} tokens` }]} /> : null}
      {context !== undefined ? (
        <seg
          key="context"
          priority={5}
          role={context >= 0.85 ? 'hermes.statusline.bad' : context >= 0.6 ? 'hermes.statusline.warn' : undefined}
          side="right"
          spans={[{ t: `${Math.round(context * 100)}% context` }]}
          title="/usage shows the breakdown"
        />
      ) : null}
      {s.compressions ? (
        <seg
          key="compressions"
          priority={2}
          role={s.compressions >= 10 ? 'hermes.statusline.bad' : s.compressions >= 5 ? 'hermes.statusline.warn' : undefined}
          side="right"
          spans={[{ t: `cmp ${s.compressions}` }]}
          title="Times the context was compressed this session"
        />
      ) : null}
      {cx.rates?.cache !== undefined ? (
        <seg
          icon="cache"
          key="cache"
          priority={1}
          side="right"
          spans={[{ t: `${Math.round(cx.rates.cache)}%` }]}
          title="Prompt tokens served from the provider's cache, this session"
        />
      ) : null}
      {cx.rates?.tps ? (
        <seg
          icon="fast"
          key="tps"
          priority={1}
          side="right"
          spans={[{ t: `${Math.round(cx.rates.tps)} t/s` }]}
          title="Output tokens per second over the recent model calls"
        />
      ) : null}
      {cx.cost ? <seg key="cost" priority={3} side="right" spans={[{ t: `$${cx.cost.toFixed(2)}` }]} title="Session cost" /> : null}
      <seg key="newline" priority={1} side="right" spans={[{ s: 'muted', t: '⇧⏎ newline' }]} />
      {cx.busy ? (
        <seg key="action" onClick={cx.onInterrupt} priority={10} role="hermes.statusline.stop" side="right" spans={[{ t: 'esc esc stop' }]} />
      ) : (
        <seg key="action" onClick={cx.onSubmit} priority={10} role="hermes.statusline.send" side="right" spans={[{ t: '⏎ send' }]} />
      )}
    </status>
  )
}

/**
 * omp's agents pill: a click (or ⌥A) opens the hub. Keyed so updates keep its node and its
 * entrance plays once. The content sits in an `omp.hud.seg`, omp's padded, hoverable pill part.
 */
function agentsPill(running: number, onOpen: () => void, focused: boolean): JSX.Element {
  return pill({
    children: [
      <icon key="icon" name="users" />,
      <spinner key="spin" style="dots" tone="accent" />,
      <text key="text" text={`${plural(running, 'agent')} running`} wrap="none" />
    ],
    focused,
    key: 'pill',
    onClick: onOpen,
    title: 'Agents  ⌥A'
  })
}

/**
 * The shells pill, in the agents pill's style: `2 shells` with a live dot, then `1 shell exited`
 * for a minute. While processes chart their output, the freshest chart's figure and mini chart
 * follow the count, and the hover card shows every running process as a tile.
 */
function shellsPill(s: ShellsPill, focused: boolean): JSX.Element {
  const live = s.running > 0
  const n = live ? s.running : s.exited
  const charts = live ? (s.charts ?? []) : []
  const fresh = latest(charts)?.view
  const figure = fresh && glance(fresh)
  const title = ['Background processes  ⌥J', ...charts.map(c => `${c.process.id}  ${summary(c.view)}`)].join('\n')
  const card = hovercard(charts)

  return pill({
    children: [
      <icon key="icon" name="terminal" />,
      live ? (
        <spinner key="spin" style="dots" tone="accent" />
      ) : (
        <icon key="end" name={s.tone === 'success' ? 'done' : s.tone === 'error' ? 'failed' : 'aborted'} tone={s.tone} />
      ),
      <text key="text" spans={[{ s: live ? undefined : 'muted', t: `${plural(n, 'shell')}${live ? '' : ' exited'}` }]} wrap="none" />,
      figure ? <text key="glance" role="omp.hud.glance" spans={glanceSpans(figure)} wrap="none" /> : null,
      fresh ? miniSpark(fresh) : null
    ],
    focused,
    hovercard: card,
    key: 'shells',
    onClick: s.onOpen,
    title
  })
}

/** The PR pill, in the shells pill's style. */
function prsPillNode(p: PrsPill, focused: boolean): JSX.Element {
  return pill({
    children: [<icon key="icon" name="merge" tone={p.tone === 'muted' ? undefined : p.tone} />, <text key="text" text={p.text} wrap="none" />],
    focused,
    key: 'prs',
    onClick: p.onOpen,
    title: 'Pull requests  ⌥P'
  })
}

/** What the keys do while a pill holds them. */
function hudHint(): JSX.Element {
  return (
    <row align="center" gap="xs" key="hint" role="omp.hud.hint">
      <kbd key="enter" keys={['enter']} />
      <text key="open" text="open" />
      <kbd key="lr" keys={['left', 'right']} />
      <text key="move" text="switch" />
      <kbd key="esc" keys={['esc']} />
      <text key="back" text="back" />
    </row>
  )
}

function workingNode(cx: DockContext): JSX.Element {
  const busy = cx.busy!

  return workingRow({
    label: busy.label,
    now: cx.now,
    since: busy.since,
    startedAt: busy.startedAt,
    trailing: [
      <row grow={1} key="fill" />,
      cx.todos ? todosPillNode(cx.todos, false) : null,
      <row align="center" gap="xs" key="stop" onClick={cx.onInterrupt} role="omp.working.stop" title="Stop  esc esc">
        <kbd key="k" keys={['esc']} />
        <kbd key="k2" keys={['esc']} />
        <text key="t" text="Stop" />
      </row>
    ]
  })
}

/** The working row while /compress runs: what holds the session, and for how long. */
function compactingNode(c: NonNullable<DockContext['compacting']>, now: number): JSX.Element {
  return workingRow({
    label: COMPACTING_LABEL,
    now,
    since: c.since,
    startedAt: c.startedAt,
    title: 'Prompts sent now wait in the queue until the compaction ends'
  })
}

/** The effort chip: the level (the default one muted), and `ultra→max` where the route clamps it. */
function effortChip(cx: DockContext): JSX.Element {
  const text = effortText(cx.effort, cx.effortWire)
  // The glyph draws what is sent.
  const glyph = cx.effort === 'none' ? 'off' : cx.effortWire || cx.effort || DEFAULT_EFFORT
  const clamp = text.includes('→') ? ` (this route sends ${cx.effortWire})` : ''

  return (
    <row
      align="center"
      gap="xs"
      key="effort"
      onClick={cx.onEffort}
      onMenu={cx.onEffortMenu}
      role="omp.composer.effort"
      title={`Reasoning effort: ${text}${cx.effort ? clamp : ' (the default)'} · click to cycle  ⇧⇥ · right-click to choose or save as default`}
    >
      <effort key="glyph" level={glyph} />
      <text key="level" spans={[{ s: cx.effort ? undefined : 'muted', t: text }]} wrap="none" />
    </row>
  )
}

function composerNode(cx: DockContext): JSX.Element {
  const { composer } = cx
  const ctx = cx.context
  const share = ctx && ctx.max > 0 ? ctx.used / ctx.max : undefined

  return (
    <col key="composer" role="omp.editor">
      {cx.busy ? <row key="streak" role="hermes.streak" /> : null}
      {share === undefined || share < 0.01 ? null : (
        // The bar alone on the composer's edge: its % and total sat in the pills' row and collided
        // with them; the status strip says the % and the tooltip the rest.
        <meter
          key="context"
          role="omp.composer.context"
          style="bar"
          thresholds={{ bad: 0.85, warn: 0.6 }}
          title={`Context ${Math.round(share * 100)}% used\n${compact(ctx!.used)} of ${compact(ctx!.max)} tokens\n/usage shows the breakdown`}
          value={share}
        />
      )}
      <row gap="sm" hidden={!cx.attachments?.length} key="chips" role="omp.composer.chips" wrap>
        {(cx.attachments ?? []).map(imageChip)}
      </row>
      <row align="start" gap="sm" key="line" role="omp.composer.line">
        <editor
          anchor={composer.anchor}
          cursor={composer.cursor}
          decor={composer.decor}
          ghost={cx.ghost || undefined}
          key="input"
          maxLines={18}
          onEdit={cx.onEdit}
          onSend={cx.onSend}
          onUndo={cx.onUndo}
          placeholder={cx.placeholder}
          sendable={cx.ready}
          text={composer.text}
        />
      </row>
      <row align="center" gap="sm" key="bar" role="omp.composer.bar">
        {cx.model ? (
          <row
            align="center"
            gap="xs"
            key="model"
            onClick={cx.onModel}
            role="omp.composer.model"
            title={`Model: ${cx.model}${cx.fast ? ` · ${cx.fast === 'ultrafast' ? 'ultrafast' : 'fast'} mode (priority processing, billed higher; /fast turns it off)` : ''} · click to switch`}
          >
            <icon key="icon" name="model" />
            <text key="name" spans={[{ t: cx.model }]} wrap="none" />
            {cx.fast ? <icon key="fast" name="bolt" role="hermes.composer.fast" tone="warning" /> : null}
            {cx.fast === 'ultrafast' ? <icon key="fast2" name="bolt" role="hermes.composer.fast" tone="warning" /> : null}
            <icon key="chev" name="chev" />
          </row>
        ) : null}
        {cx.reasons !== false ? effortChip(cx) : null}
        {/* Tern puts its folder chip right before the composer's status node: an empty one keeps
            the chip there and the send key at the end. */}
        <status grow={1} key="extras" role="omp.composer.extras" transparent />
        {cx.busy ? (
          <text
            key="stop"
            onClick={cx.onInterrupt}
            role="omp.composer.stop"
            text="Stop"
            title="Stop  esc esc"
            tone="error"
          />
        ) : (
          <kbd key="send" keys={['enter']} onClick={cx.onSubmit} role="omp.composer.send" title="Send  ⏎" />
        )}
      </row>
    </col>
  )
}

/**
 * An attached image as omp's composer chip (a card Tern lays out as a 36px thumbnail beside the
 * name and its size), as t3code's composer shows one: a click on the thumbnail opens it large in
 * Tern's lightbox; the ✕ drops it.
 */
export function imageChip(a: ComposerImage, i: number): JSX.Element {
  return (
    <card head={[{ s: 'strong', t: a.label }]} key={`a${i}`} role="omp.composer.chip" title={a.label} tone="accent">
      {a.image ? <image alt={a.label} key="thumb" {...a.image} /> : <icon key="thumb" name="image" />}
      <text
        key="caption"
        spans={[a.pending ? { fx: 'shimmer', s: 'dim', t: 'Attaching…' } : { s: 'dim', t: a.caption ?? 'image' }]}
        wrap="none"
      />
      <icon key="remove" name="x" onClick={a.onRemove} role="hermes.composer.remove" title={`Remove ${a.label}`} />
    </card>
  )
}
