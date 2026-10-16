// The `dock` region: the working row while a turn runs, queued prompts, and
// the glass composer (omp.editor) with its model chip, effort, context
// hairline and session cost. Roles match omp's so Tern's composer sheets apply.

import type { EditEvent, JSX, SendEvent } from '@stencil-hq/tern'

import type { Composer } from '../composer.js'

import { age, compact } from './time.js'

/** What the dock shows. */
export interface DockContext {
  composer: Composer
  /** The `editor` node's full id, for the caret overlay and focus. */
  inputId: string
  placeholder: string
  /** The agent accepts prompts (for Tern's `send`). */
  ready: boolean
  busy?: { since: object; startedAt: number; label: string }
  queued: readonly string[]
  model: string
  /** Hermes's reasoning effort (`none` = off); empty hides the chip. */
  effort: string
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
  /** Pull the oldest queued prompt back into the composer. */
  onQueueEdit(): void
  onContext(): void
}

/** The `dock` region's nodes: the working row, the queued prompts and the composer. */
export function dockNodes(cx: DockContext): JSX.Element[] {
  const nodes: JSX.Element[] = []

  if (cx.busy) {
    nodes.push(
      <col key="hud" role="omp.hud.status">
        {workingNode(cx)}
      </col>
    )
  }

  if (cx.queued.length) {
    nodes.push(
      <col gap="xs" key="queue" role="omp.queue">
        {cx.queued.map((text, i) => (
          <row align="center" gap="sm" key={`q${i}`} role="omp.queue.item" title="Queued">
            <icon key="icon" name="corner-down-right" />
            <text grow={1} key="text" text={text.replace(/\s*\r?\n\s*/g, ' ↵ ')} truncate="end" wrap="none" />
            {i === 0 && cx.queued.length > 1 ? (
              <badge key="count" role="omp.queue.count" text={`${cx.queued.length}`} />
            ) : null}
            <row align="center" gap="xs" key="edit" onClick={cx.onQueueEdit} role="omp.queue.edit" title="Edit  ⌥↑">
              <kbd key="k" keys={['alt', 'up']} />
              <text key="t" text="Edit" />
            </row>
          </row>
        ))}
      </col>
    )
  }

  nodes.push(composerNode(cx))

  return nodes
}

function workingNode(cx: DockContext): JSX.Element {
  const busy = cx.busy!

  return (
    <row align="center" gap="sm" key="working" role="omp.working">
      <spinner key="spinner" style="starburst" tone="accent" />
      <shimmer
        key="label"
        mode="classic"
        palette={{ high: 'accent', low: 'dim', mid: 'muted' }}
        role="omp.working.label"
        spans={[{ s: 'muted', t: busy.label }]}
      />
      <text key="sep" role="omp.working.sep" text="·" />
      <elapsed age={age(busy.since, busy.startedAt, cx.now)} format="short" key="elapsed" />
      <row grow={1} key="fill" />
      <row align="center" gap="xs" key="stop" onClick={cx.onInterrupt} role="omp.working.stop" title="Stop  esc">
        <kbd key="k" keys={['esc']} />
        <text key="t" text="Stop" />
      </row>
    </row>
  )
}

/** The effort level as omp names it: hermes's `none` is `off`. */
function effortLabel(effort: string): string {
  return effort === 'none' ? 'off' : effort
}

/** A path dim up to its last component, like omp's path segment. */
function pathSpans(path: string): { s: string; t: string }[] {
  const slash = path.lastIndexOf('/', path.length - 2)

  if (slash < 0 || slash + 1 >= path.length) {
    return [{ s: 'statusLinePath strong', t: path }]
  }

  return [
    { s: 'statusLinePath dim', t: path.slice(0, slash + 1) },
    { s: 'statusLinePath strong', t: path.slice(slash + 1) }
  ]
}

function composerNode(cx: DockContext): JSX.Element {
  const { composer } = cx
  const ctx = cx.context
  const share = ctx && ctx.max > 0 ? ctx.used / ctx.max : undefined

  return (
    <col key="composer" role="omp.editor">
      {share === undefined ? null : (
        <meter
          key="context"
          label={`${Math.round(share * 100)}%`}
          onClick={cx.onContext}
          role="omp.composer.context"
          style="bar"
          thresholds={{ bad: 0.85, warn: 0.6 }}
          title={`Context ${Math.round(share * 100)}% used\n${compact(ctx!.used)} of ${compact(ctx!.max)} tokens`}
          total={compact(ctx!.max)}
          value={share}
        />
      )}
      <row gap="sm" hidden key="chips" role="omp.composer.chips" wrap />
      <row align="start" gap="sm" key="line" role="omp.composer.line">
        <editor
          cursor={composer.cursor}
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
            title={`Model: ${cx.model} · click to switch`}
          >
            <icon key="icon" name="model" />
            <text key="name" spans={[{ t: cx.model }]} wrap="none" />
            <icon key="chev" name="chev" />
          </row>
        ) : null}
        {cx.effort ? (
          <row
            align="center"
            gap="xs"
            key="effort"
            onClick={cx.onEffort}
            role="omp.composer.effort"
            title={`Reasoning effort: ${effortLabel(cx.effort)} · click to cycle  ⇧⇥`}
          >
            <effort key="glyph" level={effortLabel(cx.effort)} />
            <text key="level" text={effortLabel(cx.effort)} wrap="none" />
          </row>
        ) : null}
        <status grow={1} key="extras" role="omp.composer.extras" transparent>
          {cx.cwd ? (
            <seg
              icon="folder"
              key="cwd"
              priority={5}
              role="omp.composer.fact"
              spans={pathSpans(cx.cwd)}
              title={cx.cwd}
            />
          ) : null}
          {cx.branch ? (
            <seg
              icon="git-branch"
              key="git"
              priority={4}
              role="omp.composer.fact"
              spans={[{ s: 'statusLineGitClean', t: cx.branch }]}
              title={`Branch ${cx.branch}`}
            />
          ) : null}
        </status>
        {cx.cost ? (
          <text
            key="usage"
            role="omp.composer.usage"
            text={`$${cx.cost.toFixed(2)}`}
            title="Session cost"
            wrap="none"
          />
        ) : null}
        {cx.busy ? (
          <text
            key="stop"
            onClick={cx.onInterrupt}
            role="omp.composer.stop"
            text="Stop"
            title="Stop  esc"
            tone="error"
          />
        ) : (
          <kbd key="send" keys={['enter']} onClick={cx.onSubmit} role="omp.composer.send" title="Send  ⏎" />
        )}
      </row>
    </col>
  )
}
