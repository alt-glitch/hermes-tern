// One frame of the pane, its steps in a fixed order: a pill that left hands the keys back
// (Hud.prune), the completion list follows the composer, the surface gets the whole view (the
// dock from dockModel(), the layers, the transcript), and then the caret moves where it belongs,
// sent only when that changed. Every step but those three only reads.

import type { Hud } from '../chrome/hud.js'
import type { Sidebar } from '../chrome/sidebar.js'
import type { Completion } from '../overlays/completion.js'
import type { Overlay } from '../overlays/overlay.js'
import type { PrAside } from '../prs/aside.js'
import { COMPOSER_ID, INPUT_ID, type SurfaceHost } from '../surface/host.js'
import type { Transcript } from '../transcript/store.js'
import { type DockActions, dockNodes } from '../view/dock.js'
import { type DockSources, dockModel, isModal, shownPills } from '../view/dockModel.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import type { WelcomeContext } from '../view/welcome.js'

/** What a frame reads and the three things it changes: the pills' focus, the completion and the surface. */
export interface FrameCx extends DockSources {
  readonly surface: Pick<SurfaceHost, 'closed' | 'follow' | 'render'>
  readonly hud: Pick<Hud, 'focused' | 'prune' | 'todosOpen'>
  readonly completion: Pick<Completion, 'ghost' | 'nodes' | 'update'>
  readonly overlays: readonly Pick<Overlay, 'focus' | 'key' | 'modal' | 'node'>[]
  readonly transcript: Pick<Transcript, 'currentTodos' | 'entries'>
  readonly prAside: Pick<PrAside, 'node' | 'open'>
  readonly sidebar: Pick<Sidebar, 'node'>
  /** Tern has the aside feature: the PR aside or the session sidebar docks at the right edge. */
  aside(): boolean
  /** The dock's buttons, bound once. */
  readonly actions: DockActions
  /** The welcome card's logo, version and tip; the backend's version stands in for a missing one. */
  readonly welcome: WelcomeContext
  /** The Copy buttons: the entry whose button reads Copied, and what a click does. */
  readonly copies: Pick<TranscriptContext, 'copied' | 'copy'>
}

/** Draws one frame at `now`; nothing once the surface closed. */
export function drawFrame(cx: FrameCx, now = Date.now()) {
  if (cx.surface.closed) {
    return
  }

  const modal = isModal(cx.overlays)
  const entries = transcriptContext(cx, now)

  // A pill that left (its last process aged out) hands the keys back.
  cx.hud.prune(shownPills(cx, now))

  // Every composer change (keys, native edits and undo, submits, queue edits) ends in a render: refresh here.
  if (!modal) {
    cx.completion.update(cx.composer)
  }

  cx.surface.render({
    dock: dockNodes(dockModel(cx, now), cx.actions),
    layer: [
      ...(cx.aside() ? [cx.prAside.open ? cx.prAside.node('layer.prs') : cx.sidebar.node('layer.sidebar')].filter(n => n !== null) : []),
      ...cx.overlays.map(o => o.node(`layer.${o.key}`)),
      ...(modal ? [] : cx.completion.nodes(COMPOSER_ID))
    ],
    main: cx.transcript.entries.map(e => entryNode(e, `main.${e.id}`, entries))
  })

  cx.surface.follow(focusOf(cx))
}

/** What the transcript's entries draw with this frame. */
function transcriptContext(cx: FrameCx, now: number): TranscriptContext {
  const info = cx.session.info
  const backend = info?.version && info.version !== 'unknown' ? `v${info.version}` : ''

  return {
    copied: cx.copies.copied,
    copy: cx.copies.copy,
    now,
    welcome: { ...cx.welcome, version: cx.welcome.version || backend }
  }
}

/** Where the caret goes: the top overlay's field; none under a modal sheet without one or while a pill holds the keys; else the composer. */
function focusOf(cx: Pick<FrameCx, 'hud' | 'overlays'>): string | null {
  const top = cx.overlays.at(-1)

  return top?.focus ? top.focus(`layer.${top.key}`) : top?.modal || cx.hud.focused ? null : INPUT_ID
}
