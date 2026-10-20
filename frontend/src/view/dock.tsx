// The `dock` region: the working row while a turn runs, queued prompts, and
// the glass composer (omp.editor) with its model chip, effort, context
// hairline and session cost. Roles match omp's so Tern's composer sheets apply.
// What it shows is data (DockContext, view/dockModel.ts builds it); what its
// buttons do is DockActions, bound once.

import type { EditEvent, JSX, SendEvent, Tone } from '@stencil-hq/tern'

import type { Composer } from '../composer.js'
import type { Pill } from '../chrome/hud.js'
import { assertNever } from '../core/assert.js'
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

/** What the dock shows, by part; dockModel() builds it each frame. */
export interface DockContext {
  readonly now: number
  /** What holds the session: the working row's state. */
  readonly activity: DockActivity
  readonly composer: DockComposer
  /** The model and reasoning effort on the composer's bar. */
  readonly route: DockRoute
  /** The lines and pills between the queue and the composer. */
  readonly pills: DockPills
  readonly queue: DockQueue
  /** The status strip under the composer. */
  readonly status: StatusLine
}

/**
 * What holds the session, for the view only: nothing, a turn (or a send's `{!cmd}`s), or a
 * compaction with no turn (/compress), whose row says so with nothing to stop.
 */
export type DockActivity =
  | { readonly kind: 'idle' }
  | { readonly kind: 'turn'; readonly since: object; readonly startedAt: number; readonly label: string }
  | { readonly kind: 'compacting'; readonly since: object; readonly startedAt: number }

/** The composer: the draft, what Tern's editor shows over it, and the images the prompt carries. */
export interface DockComposer {
  readonly draft: Composer
  readonly placeholder: string
  /** The agent accepts prompts (for Tern's `send`). */
  readonly ready: boolean
  /** The completion's ghost text after the caret. */
  readonly ghost?: string | undefined
  /** Images the next prompt carries, as chips in the composer: a thumbnail (a click opens it large) and a remove button. */
  readonly attachments: readonly ComposerImage[]
}

/** The model chip and the effort chip. */
export interface DockRoute {
  readonly model: string
  /** The session runs on a priority tier: a bolt on the model chip. */
  readonly fast?: 'fast' | 'ultrafast' | undefined
  /** Hermes's reasoning effort (`none` = off); empty is the default level, shown muted. */
  readonly effort: string
  /** The level the route really sends, when it clamps the pick (`ultra` → `max`). */
  readonly effortWire?: string | undefined
  /** False for a model without reasoning: no effort chip. */
  readonly reasons?: boolean | undefined
}

/** The reconnect line, the goal and loop line, and the pills above the composer. */
export interface DockPills {
  /** The pill holding the keyboard (Down from an empty prompt). */
  readonly focused?: Pill | undefined
  /** The agent's todo list: its pill (on the working line while a turn runs) and the panel it opens. */
  readonly todos?: TodosPill | undefined
  /** Running subagents: the pill above the composer that opens the agents hub (none at 0). */
  readonly agents?: number | undefined
  /** Background processes: the shells pill that opens the Background sheet. */
  readonly shells?: ShellsPill | undefined
  /** The conversation's pull requests: the PR pill that opens the Pull requests sheet. */
  readonly prs?: PrsPill | undefined
  /** The standing goal and loop: one line above the pills. */
  readonly automation?: Omit<AutomationLine, 'onGoal' | 'onLoop'> | undefined
  /** The gateway is being redialled. */
  readonly reconnecting?: Reconnecting | undefined
}

/** The prompts waiting behind the turn. */
export interface DockQueue {
  readonly rows: readonly QueuedRow[]
  /** A turn runs, so a row's Steer can inject it. */
  readonly canSteer: boolean
}

/** What the dock's buttons and fields do. Bound once: none of them depends on the frame. */
export interface DockActions {
  /** Native editing: Tern replaced a range of the composer's text. */
  onEdit(ev: EditEvent): void
  /** Tern submitted text into the composer (`send` feature). */
  onSend(ev: SendEvent): void
  onSubmit(): void
  onUndo(): void
  onInterrupt(): void
  onModel(): void
  onEffort(): void
  /** The effort pill's context menu, by action: choose a level, save the current one as the default. */
  readonly onEffortMenu?: Readonly<Record<string, () => void>> | undefined
  /** Pull the queued prompt at `index` back into the composer. */
  onQueueEdit(index: number): void
  /** Inject the queued prompt at `index` into the running turn; offered only while the queue's `canSteer`. */
  onQueueSteer(index: number): void
  /** Drop the composer's image chip at `index`. */
  onRemoveAttachment(index: number): void
  onAgents(): void
  onShells(): void
  onPrs(): void
  /** Fold the todo panel open or shut. */
  onTodos(): void
  onGoal(): void
  onLoop(): void
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
}

/** The agent's todo list as a pill: a ring that fills as items are done, and the one under way. */
export interface TodosPill {
  list: Todo[]
  open: boolean
}

/** The flat strip under the composer: where the session is and what it has spent. */
export interface StatusLine {
  readonly title?: string | undefined
  readonly branch: string
  readonly tokens?: number | undefined
  /** The context window's use; also the composer's hairline. */
  readonly context?: { readonly used: number; readonly max: number } | undefined
  /** Times the context was compressed this session (Ink's `cmp N`). */
  readonly compressions?: number | undefined
  readonly cost?: number | undefined
  /** The session's cache hit (percent) and recent tokens per second, when known. */
  readonly rates?: { readonly cache?: number | undefined; readonly tps?: number | undefined } | undefined
  /** The gateway's newest out-of-band notice (credits, a slow start), in its tone. */
  readonly notice?: { text: string; tone: 'error' | 'info' | 'success' | 'warning' } | undefined
}

/** The PR pill: the newest linked PR, or how many there are, toned by their checks. */
export interface PrsPill {
  text: string
  tone: Tone
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
}

/** The `dock` region's nodes: the working row, the queued prompts and the composer. */
export function dockNodes(cx: DockContext, on: DockActions): JSX.Element[] {
  const nodes: JSX.Element[] = []
  const { activity, pills: p } = cx
  const busy = activity.kind === 'turn'

  if (activity.kind !== 'idle') {
    nodes.push(
      <col key="hud" role="omp.hud.status">
        {activityNode(activity, cx, on)}
      </col>
    )
  }

  if (cx.queue.rows.length) {
    nodes.push(queuedNode(cx.queue.rows, { edit: on.onQueueEdit, steer: cx.queue.canSteer ? on.onQueueSteer : undefined }))
  }

  if (p.todos?.open) {
    nodes.push(
      <col key="todos" role="hermes.todos">
        {checklistNode(p.todos.list)}
      </col>
    )
  }

  const reconnect = reconnectNode(p.reconnecting, cx.now)

  if (reconnect) {
    nodes.push(reconnect)
  }

  const automation = automationNode(p.automation && { ...p.automation, onGoal: on.onGoal, onLoop: on.onLoop }, cx.now, p.focused)

  if (automation) {
    nodes.push(automation)
  }

  const pills = [
    // While a turn runs the todo pill rides the working line instead.
    p.todos && !busy ? todosPillNode(p.todos, on.onTodos, p.focused === 'todos') : null,
    p.agents ? agentsPill(p.agents, on.onAgents, p.focused === 'agents') : null,
    p.shells && (p.shells.running || p.shells.exited) ? shellsPill(p.shells, on.onShells, p.focused === 'shells') : null,
    p.prs ? prsPillNode(p.prs, on.onPrs, p.focused === 'prs') : null
  ].filter(n => n !== null)

  if (pills.length) {
    nodes.push(
      <row key="agents" role="omp.hud">
        {p.focused ? hudHint() : null}
        {pills}
      </row>
    )
  }

  nodes.push(composerNode(cx, on))
  nodes.push(statusLine(cx, on))

  return nodes
}

/** The working row: the turn's, or the compaction's while /compress runs with no turn. */
function activityNode(a: Exclude<DockActivity, { kind: 'idle' }>, cx: DockContext, on: DockActions): JSX.Element {
  switch (a.kind) {
    case 'turn':
      return workingNode(a, cx, on)

    case 'compacting':
      return compactingNode(a, cx.now)

    default:
      return assertNever(a, 'dock activity')
  }
}

/** The todo pill: a ring that fills as items are done, `2/5`, and the item under way. */
function todosPillNode(t: TodosPill, onToggle: () => void, focused: boolean): JSX.Element | null {
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
    onClick: onToggle,
    seg: 'hermes.todos.pill',
    title: t.open ? 'Hide the todo list' : 'Show the todo list'
  })
}

/**
 * The flat strip under everything (hermes-for-tern's console bar): the brand, the session's title
 * and branch on the left; tokens, context, cache, speed, cost and the send or stop key on the right.
 */
function statusLine(cx: DockContext, on: DockActions): JSX.Element {
  const s = cx.status
  const context = s.context && s.context.max > 0 ? s.context.used / s.context.max : undefined

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
      {s.branch ? (
        <seg icon="git-branch" key="git" priority={4} spans={[{ s: 'statusLineGitClean', t: s.branch }]} title={`Branch ${s.branch}`} />
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
      {s.rates?.cache !== undefined ? (
        <seg
          icon="cache"
          key="cache"
          priority={1}
          side="right"
          spans={[{ t: `${Math.round(s.rates.cache)}%` }]}
          title="Prompt tokens served from the provider's cache, this session"
        />
      ) : null}
      {s.rates?.tps ? (
        <seg
          icon="fast"
          key="tps"
          priority={1}
          side="right"
          spans={[{ t: `${Math.round(s.rates.tps)} t/s` }]}
          title="Output tokens per second over the recent model calls"
        />
      ) : null}
      {s.cost ? <seg key="cost" priority={3} side="right" spans={[{ t: `$${s.cost.toFixed(2)}` }]} title="Session cost" /> : null}
      <seg key="newline" priority={1} side="right" spans={[{ s: 'muted', t: '⇧⏎ newline' }]} />
      {cx.activity.kind === 'turn' ? (
        <seg key="action" onClick={on.onInterrupt} priority={10} role="hermes.statusline.stop" side="right" spans={[{ t: 'esc esc stop' }]} />
      ) : (
        <seg key="action" onClick={on.onSubmit} priority={10} role="hermes.statusline.send" side="right" spans={[{ t: '⏎ send' }]} />
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
function shellsPill(s: ShellsPill, onOpen: () => void, focused: boolean): JSX.Element {
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
    onClick: onOpen,
    title
  })
}

/** The PR pill, in the shells pill's style. */
function prsPillNode(p: PrsPill, onOpen: () => void, focused: boolean): JSX.Element {
  return pill({
    children: [<icon key="icon" name="merge" tone={p.tone === 'muted' ? undefined : p.tone} />, <text key="text" text={p.text} wrap="none" />],
    focused,
    key: 'prs',
    onClick: onOpen,
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

function workingNode(busy: Extract<DockActivity, { kind: 'turn' }>, cx: DockContext, on: DockActions): JSX.Element {
  return workingRow({
    label: busy.label,
    now: cx.now,
    since: busy.since,
    startedAt: busy.startedAt,
    trailing: [
      <row grow={1} key="fill" />,
      cx.pills.todos ? todosPillNode(cx.pills.todos, on.onTodos, false) : null,
      <row align="center" gap="xs" key="stop" onClick={on.onInterrupt} role="omp.working.stop" title="Stop  esc esc">
        <kbd key="k" keys={['esc']} />
        <kbd key="k2" keys={['esc']} />
        <text key="t" text="Stop" />
      </row>
    ]
  })
}

/** The working row while /compress runs: what holds the session, and for how long. */
function compactingNode(c: Extract<DockActivity, { kind: 'compacting' }>, now: number): JSX.Element {
  return workingRow({
    label: COMPACTING_LABEL,
    now,
    since: c.since,
    startedAt: c.startedAt,
    title: 'Prompts sent now wait in the queue until the compaction ends'
  })
}

/** The effort chip: the level (the default one muted), and `ultra→max` where the route clamps it. */
function effortChip(r: DockRoute, on: DockActions): JSX.Element {
  const text = effortText(r.effort, r.effortWire)
  // The glyph draws what is sent.
  const glyph = r.effort === 'none' ? 'off' : r.effortWire || r.effort || DEFAULT_EFFORT
  const clamp = text.includes('→') ? ` (this route sends ${r.effortWire})` : ''

  return (
    <row
      align="center"
      gap="xs"
      key="effort"
      onClick={on.onEffort}
      onMenu={on.onEffortMenu}
      role="omp.composer.effort"
      title={`Reasoning effort: ${text}${r.effort ? clamp : ' (the default)'} · click to cycle  ⇧⇥ · right-click to choose or save as default`}
    >
      <effort key="glyph" level={glyph} />
      <text key="level" spans={[{ s: r.effort ? undefined : 'muted', t: text }]} wrap="none" />
    </row>
  )
}

function composerNode(cx: DockContext, on: DockActions): JSX.Element {
  const { draft, attachments } = cx.composer
  const { route } = cx
  const busy = cx.activity.kind === 'turn'

  return (
    <col key="composer" role="omp.editor">
      {busy ? <row key="streak" role="hermes.streak" /> : null}
      {contextMeter(cx.status.context)}
      <row gap="sm" hidden={!attachments.length} key="chips" role="omp.composer.chips" wrap>
        {attachments.map((a, i) => imageChip(a, i, on.onRemoveAttachment))}
      </row>
      <row align="start" gap="sm" key="line" role="omp.composer.line">
        <editor
          anchor={draft.anchor}
          cursor={draft.cursor}
          decor={draft.decor}
          ghost={cx.composer.ghost || undefined}
          key="input"
          maxLines={18}
          onEdit={on.onEdit}
          onSend={on.onSend}
          onUndo={on.onUndo}
          placeholder={cx.composer.placeholder}
          sendable={cx.composer.ready}
          text={draft.text}
        />
      </row>
      <row align="center" gap="sm" key="bar" role="omp.composer.bar">
        {route.model ? (
          <row
            align="center"
            gap="xs"
            key="model"
            onClick={on.onModel}
            role="omp.composer.model"
            title={`Model: ${route.model}${route.fast ? ` · ${route.fast === 'ultrafast' ? 'ultrafast' : 'fast'} mode (priority processing, billed higher; /fast turns it off)` : ''} · click to switch`}
          >
            <icon key="icon" name="model" />
            <text key="name" spans={[{ t: route.model }]} wrap="none" />
            {route.fast ? <icon key="fast" name="bolt" role="hermes.composer.fast" tone="warning" /> : null}
            {route.fast === 'ultrafast' ? <icon key="fast2" name="bolt" role="hermes.composer.fast" tone="warning" /> : null}
            <icon key="chev" name="chev" />
          </row>
        ) : null}
        {route.reasons !== false ? effortChip(route, on) : null}
        {/* Tern puts its folder chip right before the composer's status node: an empty one keeps
            the chip there and the send key at the end. */}
        <status grow={1} key="extras" role="omp.composer.extras" transparent />
        {busy ? (
          <text
            key="stop"
            onClick={on.onInterrupt}
            role="omp.composer.stop"
            text="Stop"
            title="Stop  esc esc"
            tone="error"
          />
        ) : (
          <kbd key="send" keys={['enter']} onClick={on.onSubmit} role="omp.composer.send" title="Send  ⏎" />
        )}
      </row>
    </col>
  )
}

/**
 * The context bar alone on the composer's edge, from 1% used: its % and total sat in the pills'
 * row and collided with them; the status strip says the % and the tooltip the rest.
 */
function contextMeter(ctx: StatusLine['context']): JSX.Element | null {
  const share = ctx && ctx.max > 0 ? ctx.used / ctx.max : undefined

  return !ctx || share === undefined || share < 0.01 ? null : (
    <meter
      key="context"
      role="omp.composer.context"
      style="bar"
      thresholds={{ bad: 0.85, warn: 0.6 }}
      title={`Context ${Math.round(share * 100)}% used\n${compact(ctx.used)} of ${compact(ctx.max)} tokens\n/usage shows the breakdown`}
      value={share}
    />
  )
}

/**
 * An attached image as omp's composer chip (a card Tern lays out as a 36px thumbnail beside the
 * name and its size), as t3code's composer shows one: a click on the thumbnail opens it large in
 * Tern's lightbox; the ✕ drops it (`onRemove` gets the chip's index).
 */
export function imageChip(a: ComposerImage, i: number, onRemove: (index: number) => void): JSX.Element {
  return (
    <card head={[{ s: 'strong', t: a.label }]} key={`a${i}`} role="omp.composer.chip" title={a.label} tone="accent">
      {a.image ? <image alt={a.label} key="thumb" {...a.image} /> : <icon key="thumb" name="image" />}
      <text
        key="caption"
        spans={[a.pending ? { fx: 'shimmer', s: 'dim', t: 'Attaching…' } : { s: 'dim', t: a.caption ?? 'image' }]}
        wrap="none"
      />
      <icon key="remove" name="x" onClick={() => onRemove(i)} role="hermes.composer.remove" title={`Remove ${a.label}`} />
    </card>
  )
}
