// The pane's keys as data. KEYS names each shortcut the app binds itself (the help sheet lists
// them from here), and KEY_RULES is the chain a key runs down, one rule per step in the order
// they run: the first rule that handles the key stops it. The sheets, the pills and the
// completion list come before the shortcuts, and the composer's own keys come last.

import type { Key, KeyName } from '@stencil-hq/tern'

import type { Completion } from '../overlays/completion.js'
import type { Overlay } from '../overlays/overlay.js'
import type { Transcript } from '../transcript/store.js'
import type { PromptQueue } from '../turn/queue.js'
import type { LiveVoice } from '../voice/live.js'
import { HOLD_UNAVAILABLE, isHoldInfoKey, isTalkToggleKey, isVoiceToggleKey } from '../voice/hold.js'

import type { Attachments } from './attachments.js'
import type { Composer } from './composer.js'
import type { Dictation } from './dictation.js'
import type { VimComposer } from './vim.js'

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
  | 'browser'
  | 'cancel'
  | 'clearOrStop'
  | 'clipboardImage'
  | 'copyDraft'
  | 'dequeue'
  | 'effort'
  | 'plan'
  | 'fork'
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
  browser: { label: 'alt+shift+b', name: 'b', with: ['alt', 'shift'], without: ['ctrl', 'meta'] },
  cancel: { label: 'ctrl+c', name: 'c', with: ['ctrl'], without: ['alt', 'meta', 'shift'] },
  // Pressed twice: a single Esc never cancels work.
  clearOrStop: { label: 'escape escape', name: 'escape', with: [] },
  clipboardImage: { label: 'ctrl+v', name: 'v', with: ['ctrl'], without: ['alt', 'meta'] },
  copyDraft: { label: 'alt+c', name: 'c', with: ['alt'], without: ['ctrl', 'meta'] },
  dequeue: { label: 'alt+up', name: 'up', with: ['alt'] },
  effort: { label: 'shift+tab', name: 'tab', with: ['shift'] },
  fork: { label: 'alt+shift+f', name: 'f', with: ['alt', 'shift'], without: ['ctrl', 'meta'] },
  plan: { label: 'alt+shift+p', name: 'p', with: ['alt', 'shift'], without: ['ctrl', 'meta'] },
  prs: { label: 'alt+p', name: 'p', with: ['alt'], without: ['ctrl', 'meta', 'shift'] },
  quit: { label: 'ctrl+d', name: 'd', with: ['ctrl'], without: ['alt', 'meta', 'shift'] },
  sidebar: { label: 'alt+s', name: 's', with: ['alt'], without: ['ctrl', 'meta'] },
  steer: { label: 'alt+enter', name: 'enter', with: ['alt'] }
}

/** Opens the unsent draft without routing a typed slash command. */
export const EXTERNAL_EDITOR_KEY: KeyMatch = { label: 'ctrl+g', name: 'g', with: ['ctrl'], without: ['alt', 'meta', 'shift'] }

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
  /** Record key and capture cancellation, only after /voice on. */
  readonly dictation: Pick<Dictation, 'cancel' | 'onKey'>
  /** Optional modal editor; tests and non-Vim hosts retain the original key contract. */
  readonly vim?: Pick<VimComposer, 'key' | 'enabled'>
  readonly attachments: Pick<Attachments, 'any' | 'clear' | 'clearAll' | 'paste'>
  readonly queue: Pick<PromptQueue, 'count' | 'dequeue' | 'steer'>
  readonly transcript: Pick<Transcript, 'notice'>
  readonly presses: Presses
  readonly liveVoice: Pick<LiveVoice, 'blocked' | 'toggle' | 'quickToggle' | 'control'>
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
  openBrowserBlocks(): void
  openExternalEditor(): void
  openPrs(): void
  openPlan(): void
  fork(): void
  toggleSidebar(): void
  /** Attaches the clipboard's image to the next prompt. */
  attachClipboardImage(): void
  /** Alt+C copies the draft; Alt+Shift+C copies its current line. */
  copyDraft(currentLine: boolean): void
  /** Gateway-owned display.tern_keybindings, if loaded; legacy tests can use the defaults. */
  shortcut?(id: string, key: Key): boolean
  openModel?(): void
  openPalette?(): void
  openHistorySearch?(): void
  openHelp?(): void
  cycleModel?(direction: -1 | 1): void
  /** Sends the composer's draft. */
  submitDraft(): void
  /** An alternate busy Enter (Alt+Enter) steers or queues the current draft. */
  steerDraft(): void
}

/** The default matcher is for tests and before the first owning-profile read. */
function bound(cx: KeyCx, id: string, key: Key, fallback: KeyMatch): boolean {
  return cx.shortcut ? cx.shortcut(id, key) : matches(key, fallback)
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

/** Ctrl+C with no sheet open: cancels dictation, else clears the draft, stops the turn or arms exit. */
function ctrlC(cx: KeyCx) {
  if (cx.dictation.cancel()) return
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

/** Esc/Ctrl+C release live audio before clearing the composer or interrupting a turn. */
const liveCancel: KeyRule = (key, cx) => {
  if (!cx.liveVoice.blocked || (key.name !== 'escape' && !matches(key, KEYS.cancel))) {
    return false
  }
  void cx.liveVoice.control('stop')
  return true
}

/** The top overlay's own keys. */
const overlay: KeyRule = (key, _cx, top) => top?.onKey(key) === true

/** A modal sheet takes every key, used or not. */
const modal: KeyRule = (_key, _cx, top) => top?.modal === true

/** Dictation owns the record key and Escape under the top modal, before other input. */
const dictation: KeyRule = (key, cx) => cx.dictation.onKey(key)

/** Shortcuts request consent or report missing hold support; neither records a key gesture. */
const liveKeys: KeyRule = (key, cx) => {
  if (isTalkToggleKey(key)) {
    cx.liveVoice.quickToggle()
    return true
  }
  if (isVoiceToggleKey(key)) {
    cx.liveVoice.toggle()
    return true
  }
  if (isHoldInfoKey(key)) {
    cx.transcript.notice(HOLD_UNAVAILABLE, 'warning')
    return true
  }
  return false
}

/** The pills, before the completion: Enter on a focused pill opens it. */
const hud: KeyRule = (key, cx) => cx.hud(key)

const completion: KeyRule = (key, cx) => cx.completion.onKey(key)

/** A focused sheet, the HUD or completion owns Ctrl+G before this fallback. */
const externalEditor: KeyRule = (key, cx) => {
  if (!matches(key, EXTERNAL_EDITOR_KEY)) return false
  cx.openExternalEditor()
  return true
}

/** Vim owns modal keys after overlays/completion, before the app's Esc Esc shortcut. */
const vim: KeyRule = (key, cx) => {
  if (key.name === 'paste' && cx.vim?.enabled && cx.attachments.paste(key.text ?? '')) return true
  if (!cx.vim?.key(key)) return false
  if (key.name === 'escape') cx.presses.esc = 0
  return true
}

/**
 * Esc: a single one never cancels work (Ink's resolveDoubleEscAction). A second one within
 * DOUBLE_ESC_MS clears a draft into the prompt history, else stops the running turn.
 */
/** Fresh actions obey modal/HUD/completion ownership and exact modifiers. */
const appShortcuts: KeyRule = (key, cx) => {
  const actions: readonly [string, (() => void) | undefined][] = [
    ['app.model.select', cx.openModel],
    ['app.model.cycleForward', cx.cycleModel && (() => cx.cycleModel?.(1))],
    ['app.model.cycleBackward', cx.cycleModel && (() => cx.cycleModel?.(-1))],
    ['app.palette', cx.openPalette],
    ['app.history.search', cx.openHistorySearch],
    ['app.help', cx.openHelp]
  ]
  const found = actions.find(([id, run]) => Boolean(run && cx.shortcut?.(id, key)))

  found?.[1]?.()

  return found !== undefined
}

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
  if (!bound(cx, 'app.thinking.cycle', key, KEYS.effort)) {
    return false
  }

  cx.cycleEffort()

  return true
}

/** Global actions, after modal guards and before the composer. */
const SHEETS: readonly [KeyMatch, (cx: KeyCx) => void][] = [
  [KEYS.agents, cx => cx.openAgents()],
  [KEYS.background, cx => cx.openBackground()],
  [KEYS.browser, cx => cx.openBrowserBlocks()],
  [KEYS.sidebar, cx => cx.toggleSidebar()],
  [KEYS.prs, cx => cx.openPrs()],
  [KEYS.plan, cx => cx.openPlan()],
  [KEYS.fork, cx => cx.fork()]
]

const sheets: KeyRule = (key, cx) => {
  const ids = ['app.agents.hub', 'app.jobs', undefined, 'app.sidebar', 'app.prs']
  const hit = SHEETS.find(([match], index) => {
    const id = ids[index]

    return id ? bound(cx, id, key, match) : matches(key, match)
  })

  hit?.[1](cx)

  return hit !== undefined
}

/** Alt+Up: the oldest queued prompt back into the composer to edit. */
const dequeue: KeyRule = (key, cx) => {
  if (!bound(cx, 'app.message.dequeue', key, KEYS.dequeue) || !cx.queue.count()) {
    return false
  }

  cx.queue.dequeue(0)

  return true
}

/** Alt+Enter on an empty prompt: the oldest queued prompt steers the running turn. */
const steer: KeyRule = (key, cx) => {
  if (!bound(cx, 'app.message.alternate', key, KEYS.steer) || !cx.busy()) {
    return false
  }

  if (cx.composer.text) {
    cx.steerDraft()
    return true
  }

  if (!cx.queue.count()) {
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

/** Copy the draft or its current line without editing or sending it. */
const copyDraft: KeyRule = (key, cx) => {
  if (!matches(key, KEYS.copyDraft)) {
    return false
  }

  cx.copyDraft(key.shift)

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
  liveCancel,
  cancel,
  overlay,
  modal,
  dictation,
  liveKeys,
  hud,
  completion,
  externalEditor,
  appShortcuts,
  vim,
  doubleEsc,
  effort,
  sheets,
  dequeue,
  steer,
  quit,
  pasteImage,
  clipboardImage,
  copyDraft,
  composer
]

/** Runs `key` down KEY_RULES until a rule handles it; `top` is the top overlay. */
export function onKey(key: Key, cx: KeyCx, top: Overlay | undefined) {
  KEY_RULES.some(rule => rule(key, cx, top))
}

/** The composer's UTF-16 caret and word boundaries for editing keys. */
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const WORD = /[\p{L}\p{N}_]/u

export function lineStart(text: string, at: number): number {
  // lastIndexOf clamps a negative start to 0, so it would find a newline at 0 from offset 0.
  return at <= 0 ? 0 : text.lastIndexOf('\n', at - 1) + 1
}

export function lineEnd(text: string, at: number): number {
  const i = text.indexOf('\n', at)

  return i < 0 ? text.length : i
}

/** `at` when it is a grapheme boundary of `text`, else the boundary before it. */
export function boundaryAt(text: string, at: number): number {
  if (at >= text.length) {
    return text.length
  }

  let floor = 0

  for (const { index } of graphemes.segment(text)) {
    if (index > at) {
      break
    }

    floor = index
  }

  return floor
}

export function prevGrapheme(text: string, at: number): number {
  let prev = 0

  for (const { index } of graphemes.segment(text)) {
    if (index >= at) {
      break
    }

    prev = index
  }

  return prev
}

export function nextGrapheme(text: string, at: number): number {
  for (const { index, segment } of graphemes.segment(text)) {
    if (index >= at) {
      return index + segment.length
    }
  }

  return text.length
}

export function prevWord(text: string, at: number): number {
  let i = at

  while (i > 0 && !WORD.test(text[i - 1] ?? '')) {
    i--
  }

  while (i > 0 && WORD.test(text[i - 1] ?? '')) {
    i--
  }

  return i
}

export function nextWord(text: string, at: number): number {
  let i = at

  while (i < text.length && !WORD.test(text[i] ?? '')) {
    i++
  }

  while (i < text.length && WORD.test(text[i] ?? '')) {
    i++
  }

  return i
}

