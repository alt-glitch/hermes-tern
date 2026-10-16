// The prompt editor's state machine. Tern draws the `editor` node, its caret
// and its selection; the text model, keys and undo history live here.
// Offsets are UTF-16 code units, as TSP's `cursor` and `edit` events count.

import type { Key } from '@stencil-hq/tern'
import { append as appendHistory, load as loadHistory } from '@tui/lib/history.js'

/** What a key asked the app to do beyond editing. */
export type ComposerAction = 'submit' | null

interface Snapshot {
  text: string
  cursor: number
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
/** Typing within this window joins one undo step. */
const UNDO_MERGE_MS = 800
const WORD = /[\p{L}\p{N}_]/u

/** The prompt editor: text, caret, undo/redo, prompt history and kill ring, driven by keys and native edits. */
export class Composer {
  text = ''
  cursor = 0
  /** Bumped on every change, so the app knows to render. */
  rev = 0
  #undo: Snapshot[] = []
  #redo: Snapshot[] = []
  #lastEdit = 0
  #kill = ''
  /** Index into history while browsing it; history.length means the draft. */
  #browse = -1
  #draft = ''

  set(text: string, cursor = text.length) {
    this.#record({ merge: false })
    this.text = text
    this.cursor = clamp(cursor, text.length)
    this.#changed()
  }

  /** Clears the draft after a submit, remembering it in the prompt history. */
  take(): string {
    const text = this.text
    appendHistory(text)
    this.#undo = []
    this.#redo = []
    this.#browse = -1
    this.text = ''
    this.cursor = 0
    this.#changed()

    return text
  }

  insert(s: string) {
    this.#record({ merge: true })
    this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor)
    this.cursor += s.length
    this.#changed()
  }

  /** Replaces `[from, to)`: native edits from Tern and completions. */
  splice(from: number, to: number, s: string, cursor = from + s.length) {
    this.#replace({ cursor, from, merge: false, s, to })
  }

  #replace({ cursor, from, merge, s, to }: { cursor: number; from: number; merge: boolean; s: string; to: number }) {
    this.#record({ merge })
    this.text = this.text.slice(0, from) + s + this.text.slice(to)
    this.cursor = clamp(cursor, this.text.length)
    this.#changed()
  }

  /** A TSP `edit` event; ignored when the text changed since Tern saw it. */
  edit(ev: { from: number; to: number; text: string; cursor: number; len: number }) {
    if (ev.len !== this.text.length) {
      return
    }

    if (ev.from === ev.to && !ev.text) {
      this.cursor = clamp(ev.cursor, this.text.length)
      this.#changed()

      return
    }

    // Native typing arrives one character per edit: those join the typing burst like keys do.
    const typed = ev.from === ev.to && [...ev.text].length === 1 && ev.text !== '\n'
    this.#replace({ cursor: ev.cursor, from: ev.from, merge: typed, s: ev.text, to: ev.to })
  }

  undo() {
    const prev = this.#undo.pop()

    if (!prev) {
      return
    }

    this.#redo.push({ cursor: this.cursor, text: this.text })
    this.text = prev.text
    this.cursor = prev.cursor
    this.#lastEdit = 0
    this.#changed()
  }

  redo() {
    const next = this.#redo.pop()

    if (!next) {
      return
    }

    this.#undo.push({ cursor: this.cursor, text: this.text })
    this.text = next.text
    this.cursor = next.cursor
    this.#lastEdit = 0
    this.#changed()
  }

  /** Handles one editing key; false when the key isn't the composer's. */
  key(key: Key): ComposerAction | boolean {
    const { alt, ctrl, meta, shift } = key
    const name = key.name

    if (name === 'paste') {
      // One undo step of its own, never merged with the typing around it.
      const s = (key.text ?? '').replace(/\r\n?/g, '\n')
      this.splice(this.cursor, this.cursor, s)

      return true
    }

    if (name === 'enter') {
      if (shift || alt) {
        this.insert('\n')

        return true
      }

      if (this.text.slice(0, this.cursor).endsWith('\\')) {
        this.splice(this.cursor - 1, this.cursor, '\n')

        return true
      }

      return 'submit'
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

    switch (name) {
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

    if (key.text && !ctrl && !meta) {
      this.insert(key.text)

      return true
    }

    return false
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

    this.text = text
    this.cursor = text.length
    this.#changed()

    return true
  }

  #move(to: number): true {
    if (to !== this.cursor) {
      this.cursor = clamp(to, this.text.length)
      this.#lastEdit = 0
      this.#changed()
    }

    return true
  }

  #remove(from: number, to: number): true {
    if (from === to) {
      return true
    }

    this.#record({ merge: true })
    this.text = this.text.slice(0, from) + this.text.slice(to)
    this.cursor = from
    this.#changed()

    return true
  }

  #cut(from: number, to: number): true {
    if (from < to) {
      this.#kill = this.text.slice(from, to)
      this.#record({ merge: false })
      this.text = this.text.slice(0, from) + this.text.slice(to)
      this.cursor = from
      this.#changed()
    }

    return true
  }

  /** Saves an undo step; typing bursts merge into one. */
  #record({ merge }: { merge: boolean }) {
    const now = Date.now()

    if (!merge || now - this.#lastEdit > UNDO_MERGE_MS || !this.#undo.length) {
      this.#undo.push({ cursor: this.cursor, text: this.text })

      if (this.#undo.length > 200) {
        this.#undo.shift()
      }
    }

    this.#lastEdit = merge ? now : 0
    this.#redo = []
  }

  #changed() {
    this.rev++
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
