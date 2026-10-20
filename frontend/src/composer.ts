// The prompt editor's state machine. Tern draws the `editor` node, its caret
// and its selection; the text model and keys live here, the undo history in
// draft/undo.ts. Offsets are UTF-16 code units, as TSP's `cursor` and `edit`
// events count.

import type { Decor, Key } from '@stencil-hq/tern'
import { append as appendHistory, load as loadHistory } from '@tui/lib/history.js'

import { type Snapshot, UndoHistory } from './draft/undo.js'
import { listNewline, markdownDecor, type Splice, toggleMark } from './markdown.js'

/** What a key asked the app to do beyond editing. */
export type ComposerAction = 'submit' | null

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const WORD = /[\p{L}\p{N}_]/u

/** The prompt editor: text, caret, undo/redo, prompt history and kill ring, driven by keys and native edits. */
export class Composer {
  #text = ''
  #cursor = 0
  #anchor: number | undefined
  readonly #steps = new UndoHistory()
  #kill = ''
  /** Index into history while browsing it; history.length means the draft. */
  #browse = -1
  #draft = ''
  #decor: { text: string; decor: Decor[] } = { decor: [], text: '' }
  /** Pasted text that holds `{!…}` or starts with `!`: what it says is not the user's command. */
  #pasted: string[] = []

  /** The draft; only the composer's own edits change it. */
  get text(): string {
    return this.#text
  }

  /** The caret's offset in the draft. */
  get cursor(): number {
    return this.#cursor
  }

  /** The selection's other end, while text is selected (Shift+arrows, or Tern's native selection). */
  get anchor(): number | undefined {
    return this.#anchor
  }

  /** The selected range, or the caret twice. */
  get selection(): [number, number] {
    const a = this.anchor ?? this.cursor

    return a < this.cursor ? [a, this.cursor] : [this.cursor, a]
  }

  /** The draft's Markdown styling for the `editor` node, recomputed only when the text changed (not on caret moves). */
  get decor(): Decor[] {
    if (this.#decor.text !== this.text) {
      this.#decor = { decor: markdownDecor(this.text), text: this.text }
    }

    return this.#decor.decor
  }

  /** The draft's pastes that hold `{!…}` or start with `!`; `take()` forgets them. */
  get pasted(): readonly string[] {
    return this.#pasted
  }

  /** Marks `texts` as pasted again (a refused prompt back in the composer). */
  repasted(texts: readonly string[]) {
    this.#pasted.push(...texts)
  }

  /** Up/Down are walking the prompt history (Down still has somewhere to go). */
  get browsing(): boolean {
    return this.#browse >= 0
  }

  set(text: string, cursor = text.length) {
    this.#record({ merge: false })
    this.#text = text
    this.#cursor = clamp(cursor, text.length)
  }

  /** Clears the draft after a submit, remembering it in the prompt history. */
  take(): string {
    const text = this.text
    appendHistory(text)
    this.#pasted = []
    this.#steps.clear()
    this.#browse = -1
    this.#text = ''
    this.#cursor = 0
    this.#anchor = undefined

    return text
  }

  /** Types `s` at the caret, over the selection if there is one. */
  insert(s: string) {
    const [from, to] = this.selection
    this.#record({ merge: from === to })
    this.#text = this.text.slice(0, from) + s + this.text.slice(to)
    this.#cursor = from + s.length
  }

  /** Replaces `[from, to)`: native edits from Tern and completions. */
  splice(from: number, to: number, s: string, cursor = from + s.length) {
    this.#replace({ cursor, from, merge: false, s, to })
  }

  #replace({ cursor, from, merge, s, to }: { cursor: number; from: number; merge: boolean; s: string; to: number }) {
    this.#record({ merge })
    this.#text = this.text.slice(0, from) + s + this.text.slice(to)
    this.#cursor = clamp(cursor, this.text.length)
  }

  /**
   * A TSP `edit` event; ignored when the text changed since Tern saw it. A caret move may carry
   * Tern's selection anchor in its raw frame; a new line typed in a list item continues the list.
   */
  edit(ev: { from: number; to: number; text: string; cursor: number; len: number; raw?: Record<string, unknown> }) {
    if (ev.len !== this.text.length) {
      return
    }

    if (ev.from === ev.to && !ev.text) {
      this.#cursor = clamp(ev.cursor, this.text.length)
      const anchor = ev.raw?.anchor
      this.#anchor = typeof anchor === 'number' && anchor !== this.cursor ? clamp(anchor, this.text.length) : undefined

      return
    }

    if (ev.from === ev.to && ev.text === '\n') {
      const list = listNewline(this.text, ev.from)

      if (list) {
        return void this.#apply(list)
      }
    }

    // Native typing arrives one character per edit: those join the typing burst like keys do.
    const typed = ev.from === ev.to && [...ev.text].length === 1 && ev.text !== '\n'
    this.#replace({ cursor: ev.cursor, from: ev.from, merge: typed, s: ev.text, to: ev.to })
  }

  undo() {
    this.#restore(this.#steps.undo({ cursor: this.cursor, text: this.text }))
  }

  redo() {
    this.#restore(this.#steps.redo({ cursor: this.cursor, text: this.text }))
  }

  /** Puts back the draft an undo or redo step held, if there was one. */
  #restore(step: Snapshot | undefined) {
    if (step) {
      this.#text = step.text
      this.#cursor = step.cursor
      this.#anchor = undefined
      this.#browse = -1
    }
  }

  /** Handles one editing key; false when the key isn't the composer's. */
  key(key: Key): ComposerAction | boolean {
    const { alt, ctrl, meta, shift } = key
    const name = key.name

    if (name === 'paste') {
      // One undo step of its own, never merged with the typing around it.
      const s = (key.text ?? '').replace(/\r\n?/g, '\n')
      const [from, to] = this.selection

      if (pastedCommand(s)) {
        this.#pasted.push(s)
      }

      this.splice(from, to, s)

      return true
    }

    if (name === 'enter') {
      if (shift || alt) {
        return this.#newline()
      }

      // A trailing `\` is a new line: it goes, and a list item still continues.
      if (this.text.slice(0, this.cursor).endsWith('\\')) {
        const at = this.cursor - 1
        const list = listNewline(this.text.slice(0, at) + this.text.slice(this.cursor), at)

        if (list) {
          return this.#apply({ ...list, to: list.to + 1 })
        }

        this.splice(at, this.cursor, '\n')

        return true
      }

      return 'submit'
    }

    // ⌘B / ⌘I: Markdown bold and italic on the selection, or at the caret.
    if (meta && !ctrl && !alt && (name === 'b' || name === 'i')) {
      const [from, to] = this.selection

      return this.#apply(toggleMark(this.text, from, to, name === 'b' ? '**' : '_'))
    }

    if ((ctrl || meta) && name === 'z') {
      shift ? this.redo() : this.undo()

      return true
    }

    if (ctrl && !meta && !alt) {
      switch (name) {
        case 'a':
          return this.#move(lineStart(this.text, this.cursor))

        case 'e':
          return this.#move(lineEnd(this.text, this.cursor))

        case 'b':
          return this.#move(prevGrapheme(this.text, this.cursor))

        case 'f':
          return this.#move(nextGrapheme(this.text, this.cursor))

        case 'd':
          return this.#remove(this.cursor, nextGrapheme(this.text, this.cursor))
        case 'k': {
          // At a line's end, kill the newline itself (readline joins the lines).
          const end = lineEnd(this.text, this.cursor)

          return this.#cut(this.cursor, end === this.cursor ? Math.min(end + 1, this.text.length) : end)
        }

        case 'u':
          return this.#cut(lineStart(this.text, this.cursor), this.cursor)

        case 'w':

        case 'backspace':
          return this.#cut(prevWord(this.text, this.cursor), this.cursor)

        case 'y':
          if (this.#kill) {
            this.splice(this.cursor, this.cursor, this.#kill)
          }

          return true

        case 'delete':
          return this.#cut(this.cursor, nextWord(this.text, this.cursor))

        case 'home':
          return this.#move(0)

        case 'end':
          return this.#move(this.text.length)

        case 'left':
          return this.#move(prevWord(this.text, this.cursor))

        case 'right':
          return this.#move(nextWord(this.text, this.cursor))
      }

      return false
    }

    // Readline's Meta word keys (Alt+B/F/D), as terminals send them.
    if (alt && !ctrl && !meta) {
      switch (name) {
        case 'b':
          return this.#move(prevWord(this.text, this.cursor))

        case 'f':
          return this.#move(nextWord(this.text, this.cursor))

        case 'd':
          return this.#cut(this.cursor, nextWord(this.text, this.cursor))
      }
    }

    // Shift+arrows select; the moves below then extend the selection instead of dropping it.
    const selecting = shift && ['left', 'right', 'home', 'end'].includes(name)
    const anchor = selecting ? (this.anchor ?? this.cursor) : undefined

    if (!selecting && this.anchor !== undefined && (name === 'backspace' || name === 'delete')) {
      const [from, to] = this.selection

      return this.#cut(from, to)
    }

    const moved = this.#motion(key)

    if (moved !== undefined) {
      this.#anchor = anchor !== undefined && anchor !== this.cursor ? anchor : undefined

      return moved
    }

    if (key.text && !ctrl && !meta) {
      this.insert(key.text)

      return true
    }

    return false
  }

  /** The editing and motion keys without modifiers that change their meaning; undefined for others. */
  #motion(key: Key): boolean | undefined {
    const { alt, meta } = key

    switch (key.name) {
      case 'backspace':
        if (meta) {
          return this.#cut(lineStart(this.text, this.cursor), this.cursor)
        }

        return this.#remove(alt ? prevWord(this.text, this.cursor) : prevGrapheme(this.text, this.cursor), this.cursor)

      case 'delete':
        return this.#remove(this.cursor, alt ? nextWord(this.text, this.cursor) : nextGrapheme(this.text, this.cursor))

      case 'left':
        return this.#move(
          meta
            ? lineStart(this.text, this.cursor)
            : alt
              ? prevWord(this.text, this.cursor)
              : prevGrapheme(this.text, this.cursor)
        )

      case 'right':
        return this.#move(
          meta
            ? lineEnd(this.text, this.cursor)
            : alt
              ? nextWord(this.text, this.cursor)
              : nextGrapheme(this.text, this.cursor)
        )

      case 'home':
        return this.#move(lineStart(this.text, this.cursor))

      case 'end':
        return this.#move(lineEnd(this.text, this.cursor))

      case 'up':
        return meta ? this.#move(0) : this.#vertical(-1)

      case 'down':
        return meta ? this.#move(this.text.length) : this.#vertical(1)
    }

    return undefined
  }

  /** A new line at the caret; in a list item, the next item's marker comes with it. */
  #newline(): true {
    const list = this.anchor === undefined ? listNewline(this.text, this.cursor) : undefined

    if (list) {
      return this.#apply(list)
    }

    this.insert('\n')

    return true
  }

  /** Applies a Markdown edit as one undo step, with the selection it leaves. */
  #apply({ anchor, cursor, from, text, to }: Splice): true {
    this.#replace({ cursor, from, merge: false, s: text, to })
    this.#anchor = anchor !== undefined && anchor !== this.cursor ? anchor : undefined

    return true
  }

  #vertical(dir: -1 | 1): boolean {
    const start = lineStart(this.text, this.cursor)
    const end = lineEnd(this.text, this.cursor)
    const onEdge = dir < 0 ? start === 0 : end === this.text.length

    if (!onEdge) {
      const col = this.cursor - start
      const target = dir < 0 ? lineStart(this.text, start - 1) : end + 1
      const line = this.text.slice(target, lineEnd(this.text, target))

      // The same UTF-16 column can fall inside a wider grapheme (an emoji) on the target line.
      return this.#move(target + boundaryAt(line, Math.min(col, line.length)))
    }

    return this.#history(dir)
  }

  #history(dir: -1 | 1): boolean {
    const items = loadHistory()

    if (!items.length) {
      return true
    }

    if (this.#browse < 0) {
      if (dir > 0) {
        return true
      }

      this.#draft = this.text
      this.#browse = items.length
    }

    const at = Math.max(0, Math.min(items.length, this.#browse + dir))

    if (at === this.#browse) {
      return true
    }

    this.#browse = at
    const text = at === items.length ? this.#draft : (items[at] ?? '')

    if (at === items.length) {
      this.#browse = -1
    }

    this.#text = text
    this.#cursor = text.length
    this.#anchor = undefined

    return true
  }

  #move(to: number): true {
    if (to !== this.cursor || this.anchor !== undefined) {
      this.#cursor = clamp(to, this.text.length)
      this.#anchor = undefined
      this.#steps.breakBurst()
    }

    return true
  }

  #remove(from: number, to: number): true {
    if (from === to) {
      return true
    }

    this.#record({ merge: true })
    this.#text = this.text.slice(0, from) + this.text.slice(to)
    this.#cursor = from

    return true
  }

  #cut(from: number, to: number): true {
    if (from < to) {
      this.#kill = this.text.slice(from, to)
      this.#record({ merge: false })
      this.#text = this.text.slice(0, from) + this.text.slice(to)
      this.#cursor = from
    }

    return true
  }

  /** Saves an undo step; typing bursts merge into one. Every edit runs it, so it also ends a history walk. */
  #record({ merge }: { merge: boolean }) {
    // An edited history entry is the draft now: the next Up saves it and starts from the newest entry.
    this.#browse = -1
    this.#anchor = undefined
    this.#steps.record({ cursor: this.cursor, text: this.text }, { merge })
  }
}

function clamp(n: number, max: number): number {
  return Math.max(0, Math.min(max, n))
}

function lineStart(text: string, at: number): number {
  // lastIndexOf clamps a negative start to 0, so it would find a newline at 0 from offset 0.
  return at <= 0 ? 0 : text.lastIndexOf('\n', at - 1) + 1
}

function lineEnd(text: string, at: number): number {
  const i = text.indexOf('\n', at)

  return i < 0 ? text.length : i
}

/** `at` when it is a grapheme boundary of `text`, else the boundary before it. */
function boundaryAt(text: string, at: number): number {
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

function prevGrapheme(text: string, at: number): number {
  let prev = 0

  for (const { index } of graphemes.segment(text)) {
    if (index >= at) {
      break
    }

    prev = index
  }

  return prev
}

function nextGrapheme(text: string, at: number): number {
  for (const { index, segment } of graphemes.segment(text)) {
    if (index >= at) {
      return index + segment.length
    }
  }

  return text.length
}

function prevWord(text: string, at: number): number {
  let i = at

  while (i > 0 && !WORD.test(text[i - 1] ?? '')) {
    i--
  }

  while (i > 0 && WORD.test(text[i - 1] ?? '')) {
    i--
  }

  return i
}

function nextWord(text: string, at: number): number {
  let i = at

  while (i < text.length && !WORD.test(text[i] ?? '')) {
    i++
  }

  while (i < text.length && WORD.test(text[i] ?? '')) {
    i++
  }

  return i
}

/** Text that would run a command if typed: a `{!cmd}`, or a leading `!`. */
export function pastedCommand(text: string): boolean {
  return text.includes('{!') || text.trimStart().startsWith('!')
}
