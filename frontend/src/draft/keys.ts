// The pane's keys as data. KEYS names each shortcut the app binds itself (the help sheet lists
// them from here), and KEY_RULES is the chain a key runs down, one rule per step in the order
// they run: the first rule that handles the key stops it. The sheets, the pills and the
// completion list come before the shortcuts, and the composer's own keys come last.

import type { Key, KeyName } from '@stencil-hq/tern'

import type { Completion } from '../overlays/completion.js'
import type { Overlay } from '../overlays/overlay.js'
import type { Transcript } from '../transcript/store.js'
import type { PromptQueue } from '../turn/queue.js'

import type { Attachments } from './attachments.js'
import type { Composer } from './composer.js'
import type { Dictation } from './dictation.js'

/** A second Ctrl+C within this window quits. */
export const EXIT_ARM_MS = 1500
/** Two Esc presses within this window are a double Esc (Ink's DOUBLE_ESC_MS). */
export const DOUBLE_ESC_MS = 500

type Modifier = 'alt' | 'ctrl' | 'meta' | 'shift'

/** A shortcut: its key, the modifiers it needs and those it must not have, and how /help writes it. */
export interface KeyMatch {
  readonly name: KeyName
  readonly with: readonly Modifier[]
  readonly without?: readonly Modifier[]
  readonly label: string
}

/** What the app's own shortcuts do. */
export type KeyAction =
  | 'agents'
  | 'background'
  | 'cancel'
  | 'clearOrStop'
  | 'clipboardImage'
  | 'dequeue'
  | 'effort'
  | 'prs'
  | 'quit'
  | 'sidebar'
  | 'steer'

/**
 * The app's shortcuts. Alt+A/J/S/P go by the Alt modifier only: a typed å, ∫, ß or π (macOS
 * Option without Meta, or a keyboard that has the letter) is text for the composer. Alt+B/F/D
 * stay the composer's readline word keys: a Mac terminal sends Option+←/→ as ESC b / ESC f,
 * which arrive as Alt+B / Alt+F.
 */
export const KEYS: Record<KeyAction, KeyMatch> = {
  agents: { label: 'alt+a', name: 'a', with: ['alt'], without: ['ctrl', 'meta'] },
  background: { label: 'alt+j', name: 'j', with: ['alt'], without: ['ctrl', 'meta'] },
  cancel: { label: 'ctrl+c', name: 'c', with: ['ctrl'] },
  // Pressed twice: a single Esc never cancels work.
  clearOrStop: { label: 'escape escape', name: 'escape', with: [] },
  clipboardImage: { label: 'ctrl+v', name: 'v', with: ['ctrl'], without: ['alt', 'meta'] },
  dequeue: { label: 'alt+up', name: 'up', with: ['alt'] },
  effort: { label: 'shift+tab', name: 'tab', with: ['shift'] },
  prs: { label: 'alt+p', name: 'p', with: ['alt'], without: ['ctrl', 'meta'] },
  quit: { label: 'ctrl+d', name: 'd', with: ['ctrl'] },
  sidebar: { label: 'alt+s', name: 's', with: ['alt'], without: ['ctrl', 'meta'] },
  steer: { label: 'alt+enter', name: 'enter', with: ['alt'] }
}

/** Whether `key` is shortcut `match`. */
export function matches(key: Key, match: KeyMatch): boolean {
  return key.name === match.name && match.with.every(m => key[m]) && !match.without?.some(m => key[m])
}

/** When the last lone Esc and the first Ctrl+C of a quit came (ms); 0 for none. */
export interface Presses {
  esc: number
  exit: number
}

/** What the key rules reach of the app. */
export interface KeyCx {
  /** Removes `overlay` from the stack. */
  close(overlay: Overlay): void
  /** The pills' keys: Down from an empty prompt focuses them; ←/→, Enter and Esc/↑ while one holds the keys. */
  hud(key: Key): boolean
  readonly completion: Pick<Completion, 'onKey'>
  readonly composer: Pick<Composer, 'key' | 'set' | 'take' | 'text'>
  readonly attachments: Pick<Attachments, 'any' | 'clear' | 'clearAll' | 'paste'>
  /** The record key and a capture's cancel keys, while `/voice on` holds. */
  readonly dictation: Pick<Dictation, 'cancel' | 'onKey'>
  readonly queue: Pick<PromptQueue, 'count' | 'dequeue' | 'steer'>
  readonly transcript: Pick<Transcript, 'notice'>
  readonly presses: Presses
  now(): number
  /** A turn (or a send's `{!cmd}`s) runs. */
  busy(): boolean
  /** Stops the running turn. */
  interrupt(): void
  quit(): void
  /** Shift+Tab: the next reasoning effort. */
  cycleEffort(): void
  openAgents(): void
  openBackground(): void
  openPrs(): void
  toggleSidebar(): void
  /** Attaches the clipboard's image to the next prompt. */
  attachClipboardImage(): void
  /** Sends the composer's draft. */
  submitDraft(): void
}

/** One step of the chain: true when it handled `key`. `top` is the top overlay when the key came. */
export type KeyRule = (key: Key, cx: KeyCx, top: Overlay | undefined) => boolean

/** Text or images in the composer: Ctrl+C clears them before it interrupts, Ctrl+D never exits over them. */
export function hasDraft(cx: Pick<KeyCx, 'attachments' | 'composer'>): boolean {
  return Boolean(cx.composer.text || cx.attachments.any)
}

/** Esc Esc: the draft's text goes to the prompt history (Up brings it back), its images go. */
function clearDraft(cx: KeyCx) {
  if (cx.composer.text.trim()) {
    cx.composer.take()
  } else {
    cx.composer.set('')
  }

  // Its images go; one still uploading lands after.
  cx.attachments.clear()
}

/** Ctrl+C with no sheet open: drops a capture, else clears the draft, else stops the turn, else arms the exit (twice quits). */
function ctrlC(cx: KeyCx) {
  if (cx.dictation.cancel()) {
    return
  }

  if (hasDraft(cx)) {
    cx.composer.set('')
    cx.attachments.clearAll()

    return
  }

  if (cx.busy()) {
    return cx.interrupt()
  }

  const now = cx.now()

  if (now - cx.presses.exit < EXIT_ARM_MS) {
    return cx.quit()
  }

  cx.presses.exit = now
  cx.transcript.notice('Press Ctrl+C again to exit.')
}

/** Ctrl+C: the sheet on top answers first (a prompt's safe answer: deny, skip, cancel; a picker closes). */
const cancel: KeyRule = (key, cx, top) => {
  if (!matches(key, KEYS.cancel)) {
    return false
  }

  if (!top) {
    ctrlC(cx)
  } else if (top.cancel) {
    top.cancel()
  } else {
    cx.close(top)
  }

  return true
}

/** The top overlay's own keys. */
const overlay: KeyRule = (key, _cx, top) => top?.onKey(key) === true

/** A modal sheet takes every key, used or not. */
const modal: KeyRule = (_key, _cx, top) => top?.modal === true

/** Dictation, before the pills and Esc's own rules: the record key, and Esc dropping a capture. */
const dictation: KeyRule = (key, cx) => cx.dictation.onKey(key)

/** The pills, before the completion: Enter on a focused pill opens it. */
const hud: KeyRule = (key, cx) => cx.hud(key)

const completion: KeyRule = (key, cx) => cx.completion.onKey(key)

/**
 * Esc: a single one never cancels work (Ink's resolveDoubleEscAction). A second one within
 * DOUBLE_ESC_MS clears a draft into the prompt history, else stops the running turn.
 */
const doubleEsc: KeyRule = (key, cx) => {
  if (!matches(key, KEYS.clearOrStop)) {
    return false
  }

  const now = cx.now()
  const double = now - cx.presses.esc <= DOUBLE_ESC_MS
  cx.presses.esc = double ? 0 : now

  if (double && hasDraft(cx)) {
    clearDraft(cx)
  } else if (double && cx.busy()) {
    cx.interrupt()
  }

  return true
}

const effort: KeyRule = (key, cx) => {
  if (!matches(key, KEYS.effort)) {
    return false
  }

  cx.cycleEffort()

  return true
}

/** The sheets Alt+A/J/S/P open. */
const SHEETS: readonly [KeyMatch, (cx: KeyCx) => void][] = [
  [KEYS.agents, cx => cx.openAgents()],
  [KEYS.background, cx => cx.openBackground()],
  [KEYS.sidebar, cx => cx.toggleSidebar()],
  [KEYS.prs, cx => cx.openPrs()]
]

const sheets: KeyRule = (key, cx) => {
  const hit = SHEETS.find(([match]) => matches(key, match))

  hit?.[1](cx)

  return hit !== undefined
}

/** Alt+Up: the oldest queued prompt back into the composer to edit. */
const dequeue: KeyRule = (key, cx) => {
  if (!matches(key, KEYS.dequeue) || !cx.queue.count()) {
    return false
  }

  cx.queue.dequeue(0)

  return true
}

/** Alt+Enter on an empty prompt: the oldest queued prompt steers the running turn. */
const steer: KeyRule = (key, cx) => {
  if (!matches(key, KEYS.steer) || !cx.busy() || !cx.queue.count() || cx.composer.text) {
    return false
  }

  cx.queue.steer(0)

  return true
}

/** Ctrl+D on an empty prompt quits (with a draft it is the composer's delete-forward). */
const quit: KeyRule = (key, cx) => {
  if (!matches(key, KEYS.quit) || hasDraft(cx)) {
    return false
  }

  cx.quit()

  return true
}

/** An image: a paste with no text (what a terminal sends for a clipboard image), or a pasted or dropped image path. */
const pasteImage: KeyRule = (key, cx) => key.name === 'paste' && cx.attachments.paste(key.text ?? '')

/** Ctrl+V: the clipboard's image. */
const clipboardImage: KeyRule = (key, cx) => {
  if (!matches(key, KEYS.clipboardImage)) {
    return false
  }

  cx.attachClipboardImage()

  return true
}

/** The composer's keys; Enter sends the draft. */
const composer: KeyRule = (key, cx) => {
  if (cx.composer.key(key) === 'submit') {
    cx.submitDraft()
  }

  return true
}

/** The chain, in the order the rules run. */
export const KEY_RULES: readonly KeyRule[] = [
  cancel,
  overlay,
  modal,
  dictation,
  hud,
  completion,
  doubleEsc,
  effort,
  sheets,
  dequeue,
  steer,
  quit,
  pasteImage,
  clipboardImage,
  composer
]

/** Runs `key` down KEY_RULES until a rule handles it; `top` is the top overlay. */
export function onKey(key: Key, cx: KeyCx, top: Overlay | undefined) {
  KEY_RULES.some(rule => rule(key, cx, top))
}
