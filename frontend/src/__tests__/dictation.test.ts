// Dictation: dictation.py's lines read once, the record key from config.yaml, the store's capture
// from the record key to the words at the caret, the helper's process, and the pane end to end.
// Nothing here opens a microphone: the recorder is a fake, and the helper a stand-in script.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Node } from '@stencil-hq/tern'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Composer } from '../draft/composer.js'
import { Dictation } from '../draft/dictation.js'
import { matches } from '../draft/keys.js'
import { type Capture, hermesRecorder, type Recorder, recordKey } from '../hermes/dictation.js'
import { type DictationCheck, type DictationEvent, dictationEvent, readDictationCheck } from '../wire/files.js'

import { settle, setup } from './appSetup.js'
import { key, must, topNodes } from './fakes.js'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))

/** A capture the test drives: what the store asked of it, and the lines the helper would write. */
class FakeCapture implements Capture {
  readonly asked: string[] = []
  readonly #exit = Promise.withResolvers<void>()
  readonly closed = this.#exit.promise

  constructor(readonly on: (event: DictationEvent) => void) {}

  stop() {
    this.asked.push('stop')
  }

  cancel() {
    this.asked.push('cancel')
  }

  /** The helper writes `events`, in order. */
  write(...events: DictationEvent[]) {
    events.forEach(e => this.on(e))
  }

  /** The helper exits (the microphone is released). */
  exit() {
    this.#exit.resolve()
  }
}

class FakeRecorder implements Recorder {
  answer: DictationCheck = { details: 'Audio capture: OK\nSTT provider: OK (local faster-whisper)', ready: true }
  readonly captures: FakeCapture[] = []

  check() {
    return Promise.resolve(this.answer)
  }

  start(on: (event: DictationEvent) => void) {
    const capture = new FakeCapture(on)
    this.captures.push(capture)

    return capture
  }

  /** The capture the store opened last. */
  get last(): FakeCapture {
    return must(this.captures.at(-1), 'a capture')
  }
}

const listening: DictationEvent = { kind: 'state', state: 'listening' }
const transcribing: DictationEvent = { kind: 'state', state: 'transcribing' }
const idle: DictationEvent = { kind: 'state', state: 'idle' }
const altV = key('v', { alt: true })

function dictation(text = '') {
  const composer = new Composer()
  composer.set(text)
  const recorder = new FakeRecorder()
  const notes: string[] = []
  const d = new Dictation({ changed: () => undefined, composer, note: note => void notes.push(note) }, recorder)

  return { composer, d, notes, recorder }
}

describe("dictation.py's lines", () => {
  it('read as states, what was heard, the words and errors; anything else is dropped', () => {
    expect(dictationEvent('{"state": "listening"}')).toEqual(listening)
    expect(dictationEvent('{"partial": "hel"}')).toEqual({ kind: 'partial', text: 'hel' })
    expect(dictationEvent('{"text": "hello there"}')).toEqual({ kind: 'text', text: 'hello there' })
    expect(dictationEvent('{"error": "no input device"}')).toEqual({ kind: 'error', message: 'no input device' })
    expect(dictationEvent('{"state": "dreaming"}')).toBeUndefined()
    expect(dictationEvent('ALSA lib pcm.c: unable to open slave')).toBeUndefined()
  })

  it("read --check's last line", () => {
    expect(readDictationCheck('noise\n{"ready": false, "details": "STT provider: MISSING"}\n')).toEqual({ details: 'STT provider: MISSING', ready: false })
    expect(readDictationCheck('{"error": "voice input is not installed"}')).toEqual({ error: 'voice input is not installed' })
    expect(readDictationCheck('')).toBeUndefined()
  })
})

describe('the record key', () => {
  it('is Alt+V unless voice.record_key names another, in the forms Ink reads', () => {
    expect(recordKey(undefined)).toEqual({ label: 'alt+v', name: 'v', with: ['alt'], without: ['ctrl', 'meta'] })
    // Hermes' default, which config.get hands out when config.yaml sets none: Tern's editor keeps it.
    expect(recordKey('ctrl+b')).toEqual(recordKey(undefined))
    expect(recordKey('ctrl+g')).toEqual({ label: 'ctrl+g', name: 'g', with: ['ctrl'], without: ['alt', 'meta'] })
    expect(matches(key('space', { alt: true }), recordKey('alt+space'))).toBe(true)
    expect(matches(key('space', { alt: true, ctrl: true }), recordKey('alt+space'))).toBe(false)
    expect(recordKey('super+r')).toMatchObject({ name: 'r', with: ['meta'] })
    // The pane's own Ctrl+C, and a chord of two modifiers, are not record keys: both fall back.
    expect(recordKey('ctrl+c').name).toBe('v')
    expect(recordKey('ctrl+alt+r').name).toBe('v')
  })
})

describe('Dictation', () => {
  it('is off until /voice on, so the record key stays the composer’s', () => {
    const { d, recorder } = dictation()

    expect(d.onKey(altV)).toBe(false)
    expect(d.cancel()).toBe(false)
    expect(recorder.captures).toHaveLength(0)
  })

  it('stays off when the machine has no microphone or STT, and says why', async () => {
    const { d, notes, recorder } = dictation()
    recorder.answer = { details: 'Audio capture: MISSING (no input device)', ready: false }

    expect(await d.enable(undefined)).toBe(false)
    expect(d.phase).toBe('off')
    expect(notes.at(-1)).toContain('Audio capture: MISSING')
  })

  it('writes the words at the caret, spaced, as one undo step, and never sends them', async () => {
    const { composer, d, recorder } = dictation('hello')
    await d.enable('ctrl+g')
    composer.key(key('left'))
    composer.key(key('left'))
    composer.key(key('left'))

    expect(d.onKey(altV)).toBe(false)
    expect(d.onKey(key('g', { ctrl: true }))).toBe(true)
    expect(d.phase).toBe('starting')

    const capture = recorder.last
    capture.write(listening, { kind: 'partial', text: 'big' })
    expect(d).toMatchObject({ heard: 'big', phase: 'listening' })

    d.toggle()
    expect(capture.asked).toEqual(['stop'])
    expect(d.phase).toBe('transcribing')
    // A `listening` the helper wrote before it read the stop does not reopen the row.
    capture.write(listening)
    expect(d.phase).toBe('transcribing')

    capture.write(transcribing, { kind: 'text', text: ' big ' }, idle)
    expect(composer.text).toBe('he big llo')
    expect(d).toMatchObject({ heard: '', phase: 'ready' })

    composer.undo()
    expect(composer.text).toBe('hello')
  })

  it('throws a capture away on Esc and drops what its helper writes after', async () => {
    const { composer, d, recorder } = dictation('draft')
    await d.enable(undefined)
    d.toggle()
    const capture = recorder.last
    capture.write(listening)

    expect(d.onKey(key('escape', { shift: true }))).toBe(false)
    expect(d.onKey(key('escape'))).toBe(true)
    expect(capture.asked).toEqual(['cancel'])
    expect(d.phase).toBe('ready')

    capture.write({ kind: 'text', text: 'too late' }, idle)
    expect(composer.text).toBe('draft')
    // Esc with no capture goes on to the composer's own rules.
    expect(d.onKey(key('escape'))).toBe(false)
  })

  it('waits for the last helper to release the microphone before it opens another', async () => {
    const { d, notes, recorder } = dictation()
    await d.enable(undefined)
    d.toggle()
    d.cancel()
    d.toggle()

    expect(recorder.captures).toHaveLength(1)
    expect(notes.at(-1)).toContain('still closing')

    recorder.last.exit()
    await Promise.resolve()
    await Promise.resolve()
    d.toggle()
    expect(recorder.captures).toHaveLength(2)
  })

  it('ends on an error, says so, and says when it heard nothing', async () => {
    const { d, notes, recorder } = dictation()
    await d.enable(undefined)
    d.toggle()
    recorder.last.write({ kind: 'error', message: 'OSError: no input device' })

    expect(notes.at(-1)).toBe('Dictation failed: OSError: no input device')
    expect(recorder.last.asked).toEqual(['cancel'])
    expect(d.phase).toBe('ready')

    recorder.last.exit()
    await vi.waitFor(() => {
      d.toggle()
      expect(recorder.captures).toHaveLength(2)
    })
    d.finish()
    recorder.last.write(transcribing, idle)
    expect(notes.at(-1)).toBe('Dictation heard nothing.')
  })

  it('/voice off drops the capture and gives the record key back', async () => {
    const { d, recorder } = dictation()
    await d.enable(undefined)
    d.toggle()
    d.disable()

    expect(recorder.last.asked).toEqual(['cancel'])
    expect(d.phase).toBe('off')
    expect(d.onKey(altV)).toBe(false)
  })
})

describe('hermesRecorder: dictation.py in its own process', () => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-tern-dictation-'))
  const ui = join(root, 'frontend')
  mkdirSync(ui)
  // A stand-in for the helper: the same lines and commands, no microphone.
  writeFileSync(
    join(root, 'dictation.py'),
    [
      'import json, sys',
      'say = lambda **e: print(json.dumps(e), flush=True)',
      'if "--check" in sys.argv:',
      '    say(ready=True, details="Audio capture: OK")',
      '    sys.exit()',
      'say(state="listening")',
      'command = sys.stdin.readline().strip()',
      'if command == "stop":',
      '    say(state="transcribing")',
      '    say(text="hello from the helper")',
      'say(state="idle")'
    ].join('\n')
  )
  chmodSync(join(root, 'dictation.py'), 0o644)
  const env = { ...process.env, HERMES_PYTHON: 'python3', HERMES_PYTHON_SRC_ROOT: root, HERMES_TUI_DIR: ui }

  it('is undefined without the interpreter the launcher names', () => {
    expect(hermesRecorder({})).toBeUndefined()
  })

  it('checks, captures, stops and exits', async () => {
    const recorder = must(hermesRecorder(env), 'a recorder')
    expect(await recorder.check()).toEqual({ details: 'Audio capture: OK', ready: true })

    const events: DictationEvent[] = []
    const capture = recorder.start(event => void events.push(event))
    await vi.waitFor(() => expect(events).toEqual([listening]))
    capture.stop()
    await capture.closed

    expect(events).toEqual([listening, transcribing, { kind: 'text', text: 'hello from the helper' }, idle])
  })

  it('a cancelled capture keeps nothing, and its exit still ends it', async () => {
    const recorder = must(hermesRecorder(env), 'a recorder')
    const events: DictationEvent[] = []
    const capture = recorder.start(event => void events.push(event))
    await vi.waitFor(() => expect(events).toEqual([listening]))
    capture.cancel()
    await capture.closed

    expect(events).toEqual([listening, idle])
  })
})

describe('App: dictation', () => {
  beforeEach(() => {
    delete process.env['HERMES_TUI_QUERY']
    delete process.env['HERMES_TUI_IMAGE']
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** The dock's composer, as the app drew it last. */
  const composerOf = (dock: Node[]) => must(dock.find(n => n.props['role'] === 'omp.editor'), 'the composer')
  const roles = (n: Node): string[] => [String(n.props['role'] ?? ''), ...n.children.flatMap(roles)]

  it('/voice on arms config.yaml’s record key; Enter ends the capture, the words wait in the composer', async () => {
    const recorder = new FakeRecorder()
    const { app, dock, press, sent, type } = setup({ 'config.get': () => ({ config: { voice: { record_key: 'ctrl+g' } } }) }, { recorder })
    await type('/voice on')
    await press(key('enter'))
    await vi.waitFor(() => expect(app.dictation.phase).toBe('ready'))

    expect(sent('config.get')).toContainEqual({ key: 'full', session_id: 's1' })
    expect(sent('slash.exec')).toEqual([])
    expect(roles(composerOf(dock()))).toContain('hermes.composer.mic')

    await type('fix the')
    await press(key('g', { ctrl: true }))
    recorder.last.write(listening, { kind: 'partial', text: 'flaky test' })
    await settle()

    const row = must(topNodes(composerOf(dock()).children).find(n => n.props['role'] === 'hermes.dictation'), 'the capture row')
    expect(roles(row)).toEqual(expect.arrayContaining(['hermes.dictation.state', 'hermes.dictation.heard']))

    // Enter while it listens ends the capture: nothing is sent.
    await press(key('enter'))
    expect(recorder.last.asked).toEqual(['stop'])
    expect(sent('prompt.submit')).toEqual([])

    recorder.last.write(transcribing, { kind: 'text', text: 'flaky test' }, idle)
    await settle()
    expect(app.stores.composer.text).toBe('fix the flaky test')
    expect(roles(composerOf(dock()))).not.toContain('hermes.dictation')
    expect(sent('prompt.submit')).toEqual([])

    await press(key('enter'))
    expect(sent('prompt.submit')).toMatchObject([{ text: 'fix the flaky test' }])
  })

  it('Ctrl+C drops a capture before it touches the draft', async () => {
    const recorder = new FakeRecorder()
    const { app, press, type } = setup({}, { recorder })
    await type('/voice on')
    await press(key('enter'))
    await vi.waitFor(() => expect(app.dictation.phase).toBe('ready'))
    await type('keep me')
    await press(altV)
    await press(key('c', { ctrl: true }))

    expect(recorder.last.asked).toEqual(['cancel'])
    expect(app.stores.composer.text).toBe('keep me')
  })
})
