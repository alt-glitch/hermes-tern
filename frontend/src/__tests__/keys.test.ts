// The pane's entry points as data: each key rule alone and the order they run in, the shortcuts
// the help sheet lists, the Tern actions, a command's answer read once, and the commands' host.
import { type Key, node } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { sessionHost, type SessionHostCx } from '../commands/host.js'
import { commandEnvelope } from '../commands/slash.js'
import { liveSessionId, storedSessionId } from '../core/ids.js'
import { DOUBLE_ESC_MS, EXIT_ARM_MS, KEY_RULES, type KeyCx, KEYS, matches, onKey } from '../draft/keys.js'
import type { Overlay } from '../overlay.js'
import { HOTKEYS } from '../overlays/help.js'
import { ACTIONS, type ActionCx, onTernEvent } from '../surface/actions.js'
import { INPUT_ID } from '../surface/host.js'
import type { Busy } from '../turn/activity.js'

import { FakeGateway, key } from './fakes.js'

/** The pane as the key rules see it, recording what each rule did. */
interface Pane {
  text: string
  images: boolean
  busy: boolean
  queued: number
  /** The pills or the completion list take the key. */
  hud: boolean
  completion: boolean
  /** A paste is an image. */
  image: boolean
  /** The composer's answer to a key. */
  composerSays: 'submit' | null
  clock: number
}

function pane(over: Partial<Pane> = {}) {
  const state: Pane = { busy: false, clock: 10_000, completion: false, composerSays: null, hud: false, image: false, images: false, queued: 0, text: '', ...over }
  const log: string[] = []
  const did = (what: string) => () => void log.push(what)

  const cx: KeyCx = {
    attachClipboardImage: did('clipboard'),
    attachments: {
      get any() {
        return state.images
      },
      clear: did('clear images'),
      clearAll: did('clear all images'),
      paste: text => {
        log.push(`paste ${text}`)

        return state.image
      }
    },
    busy: () => state.busy,
    close: o => void log.push(`close ${o.key}`),
    completion: { onKey: () => state.completion },
    composer: {
      key: () => {
        log.push('composer')

        return state.composerSays
      },
      set: text => {
        log.push(`set '${text}'`)
        state.text = text
      },
      take: () => {
        log.push('take')
        const was = state.text
        state.text = ''

        return was
      },
      get text() {
        return state.text
      }
    },
    cycleEffort: did('effort'),
    hud: () => state.hud,
    interrupt: did('interrupt'),
    now: () => state.clock,
    openAgents: did('agents'),
    openBackground: did('background'),
    openPrs: did('prs'),
    presses: { esc: 0, exit: 0 },
    queue: {
      count: () => state.queued,
      dequeue: i => void log.push(`dequeue ${i}`),
      steer: i => void log.push(`steer ${i}`)
    },
    quit: did('quit'),
    submitDraft: did('submit'),
    toggleSidebar: did('sidebar'),
    transcript: { notice: text => void log.push(`notice ${text}`) }
  }

  return { cx, log, state }
}

/** An overlay with `key`, which takes keys when `takes` says so. */
function sheet(over: Partial<Overlay> & { takes?: boolean } = {}): Overlay & { seen: Key[] } {
  const seen: Key[] = []

  return {
    key: 'sheet',
    node: () => node('box', { key: 'sheet' }),
    onKey: k => {
      seen.push(k)

      return over.takes ?? false
    },
    seen,
    ...over
  }
}

const ctrl = (name: string) => key(name, { ctrl: true })
const alt = (name: string) => key(name, { alt: true })

describe('the key rules', () => {
  it('run in this order', () => {
    expect(KEY_RULES.map(rule => rule.name)).toEqual([
      'cancel',
      'overlay',
      'modal',
      'hud',
      'completion',
      'doubleEsc',
      'effort',
      'sheets',
      'dequeue',
      'steer',
      'quit',
      'pasteImage',
      'clipboardImage',
      'composer'
    ])
  })

  it('1. Ctrl+C: the top sheet cancels, else closes; with none it clears the draft, interrupts or arms the exit', () => {
    const p = pane({ text: 'draft' })
    const cancelled: string[] = []

    onKey(ctrl('c'), p.cx, sheet({ cancel: () => void cancelled.push('cancel') }))
    onKey(ctrl('c'), p.cx, sheet())
    expect(cancelled).toEqual(['cancel'])
    expect(p.log).toEqual(['close sheet'])

    onKey(ctrl('c'), p.cx, undefined)
    expect(p.log.slice(1)).toEqual(["set ''", 'clear all images'])

    p.state.busy = true
    onKey(ctrl('c'), p.cx, undefined)
    expect(p.log.at(-1)).toBe('interrupt')

    p.state.busy = false
    onKey(ctrl('c'), p.cx, undefined)
    expect(p.log.at(-1)).toBe('notice Press Ctrl+C again to exit.')
    p.state.clock += EXIT_ARM_MS - 1
    onKey(ctrl('c'), p.cx, undefined)
    expect(p.log.at(-1)).toBe('quit')
  })

  it('1. Ctrl+C after the exit window arms it again', () => {
    const p = pane()

    onKey(ctrl('c'), p.cx, undefined)
    p.state.clock += EXIT_ARM_MS
    onKey(ctrl('c'), p.cx, undefined)
    expect(p.log).toEqual(['notice Press Ctrl+C again to exit.', 'notice Press Ctrl+C again to exit.'])
  })

  it('2. the top sheet sees a key first, and one it takes goes no further', () => {
    const p = pane()
    const top = sheet({ takes: true })

    onKey(key('x', { text: 'x' }), p.cx, top)
    expect(top.seen.map(k => k.name)).toEqual(['x'])
    expect(p.log).toEqual([])
  })

  it('3. a modal sheet swallows the keys it does not take', () => {
    const p = pane({ queued: 1 })

    onKey(alt('up'), p.cx, sheet({ modal: true }))
    onKey(key('enter'), p.cx, sheet({ modal: true }))
    expect(p.log).toEqual([])

    // A sheet that is not modal lets them through.
    onKey(alt('up'), p.cx, sheet())
    expect(p.log).toEqual(['dequeue 0'])
  })

  it('4. the pills take their keys before the completion list and the composer', () => {
    const p = pane({ completion: true, hud: true })

    onKey(key('down'), p.cx, undefined)
    expect(p.log).toEqual([])

    p.state.hud = false
    p.state.completion = false
    onKey(key('down'), p.cx, undefined)
    expect(p.log).toEqual(['composer'])
  })

  it('5. the completion list takes its keys before Esc and the composer', () => {
    const p = pane({ busy: true, completion: true })

    onKey(key('escape'), p.cx, undefined)
    onKey(key('escape'), p.cx, undefined)
    onKey(key('tab'), p.cx, undefined)
    expect(p.log).toEqual([])
    expect(p.cx.presses.esc).toBe(0)
  })

  it('6. Esc Esc clears a draft into the history, else stops the turn; one Esc does nothing', () => {
    const p = pane({ busy: true, text: 'draft' })

    onKey(key('escape'), p.cx, undefined)
    expect(p.log).toEqual([])

    p.state.clock += DOUBLE_ESC_MS
    onKey(key('escape'), p.cx, undefined)
    expect(p.log).toEqual(['take', 'clear images'])

    // The pair reset the clock: the next Esc starts a new pair.
    onKey(key('escape'), p.cx, undefined)
    expect(p.log).toHaveLength(2)
    onKey(key('escape'), p.cx, undefined)
    expect(p.log.slice(2)).toEqual(['interrupt'])

    // Too far apart: two lone presses.
    p.state.clock += 1
    onKey(key('escape'), p.cx, undefined)
    p.state.clock += DOUBLE_ESC_MS + 1
    onKey(key('escape'), p.cx, undefined)
    expect(p.log).toHaveLength(3)
  })

  it('6. Esc Esc over images alone sets the empty text instead of taking it', () => {
    const p = pane({ images: true, text: '  ' })

    onKey(key('escape'), p.cx, undefined)
    onKey(key('escape'), p.cx, undefined)
    expect(p.log).toEqual(["set ''", 'clear images'])
  })

  it('7. Shift+Tab cycles the reasoning effort', () => {
    const p = pane()

    onKey(key('tab', { shift: true }), p.cx, undefined)
    expect(p.log).toEqual(['effort'])
  })

  it('8. Alt+A/J/S/P open their sheets, by the Alt modifier only', () => {
    const p = pane()

    for (const name of ['a', 'j', 's', 'p']) {
      onKey(alt(name), p.cx, undefined)
    }

    expect(p.log).toEqual(['agents', 'background', 'sidebar', 'prs'])

    // With Ctrl or Meta held, or another letter, they are the composer's.
    onKey(key('a', { alt: true, ctrl: true }), p.cx, undefined)
    onKey(key('s', { alt: true, meta: true }), p.cx, undefined)
    onKey(alt('b'), p.cx, undefined)
    expect(p.log.slice(4)).toEqual(['composer', 'composer', 'composer'])
  })

  it('9. Alt+Up edits the oldest queued prompt, when one waits', () => {
    const p = pane()

    onKey(alt('up'), p.cx, undefined)
    p.state.queued = 2
    onKey(alt('up'), p.cx, undefined)
    expect(p.log).toEqual(['composer', 'dequeue 0'])
  })

  it('10. Alt+Enter steers with the oldest queued prompt: a turn runs, one waits, the prompt is empty', () => {
    const p = pane({ busy: true, queued: 1 })

    onKey(alt('enter'), p.cx, undefined)
    expect(p.log).toEqual(['steer 0'])

    for (const over of [{ busy: false }, { queued: 0 }, { text: 'x' }]) {
      const q = pane({ busy: true, queued: 1, ...over })

      onKey(alt('enter'), q.cx, undefined)
      expect(q.log).toEqual(['composer'])
    }
  })

  it('11. Ctrl+D quits on an empty prompt, and is the composer key over a draft', () => {
    const p = pane()

    onKey(ctrl('d'), p.cx, undefined)
    expect(p.log).toEqual(['quit'])

    for (const over of [{ text: 'x' }, { images: true }]) {
      const q = pane(over)

      onKey(ctrl('d'), q.cx, undefined)
      expect(q.log).toEqual(['composer'])
    }
  })

  it('12. a paste that is an image attaches it; one that is text goes to the composer', () => {
    const p = pane({ image: true })

    onKey(key('paste', { text: '/tmp/a.png' }), p.cx, undefined)
    expect(p.log).toEqual(['paste /tmp/a.png'])

    p.state.image = false
    onKey(key('paste'), p.cx, undefined)
    expect(p.log.slice(1)).toEqual(['paste ', 'composer'])
  })

  it('13. Ctrl+V attaches the clipboard image, not with Alt or Meta held', () => {
    const p = pane()

    onKey(ctrl('v'), p.cx, undefined)
    onKey(key('v', { alt: true, ctrl: true }), p.cx, undefined)
    onKey(key('v', { ctrl: true, meta: true }), p.cx, undefined)
    expect(p.log).toEqual(['clipboard', 'composer', 'composer'])
  })

  it('14. the composer takes the rest, and its submit sends the draft', () => {
    const p = pane()

    onKey(key('x', { text: 'x' }), p.cx, undefined)
    p.state.composerSays = 'submit'
    onKey(key('enter'), p.cx, undefined)
    expect(p.log).toEqual(['composer', 'composer', 'submit'])
  })

  it('stop at the first rule that handles the key', () => {
    // Ctrl+C beats the sheet's own keys; the sheet beats the modal swallow and every shortcut.
    const p = pane({ busy: true, hud: true, queued: 1 })
    const top = sheet({ takes: true })

    onKey(ctrl('c'), p.cx, top)
    expect(top.seen).toEqual([])
    expect(p.log).toEqual(['close sheet'])

    onKey(alt('up'), p.cx, top)
    expect(top.seen.map(k => k.name)).toEqual(['up'])
    expect(p.log).toHaveLength(1)

    // The pills beat Alt+Enter's steer; with them done, the steer beats the composer.
    onKey(alt('enter'), p.cx, undefined)
    expect(p.log).toHaveLength(1)
    p.state.hud = false
    onKey(alt('enter'), p.cx, undefined)
    expect(p.log.slice(1)).toEqual(['steer 0'])

    // The completion list beats the double Esc, which beats the composer.
    p.state.completion = true
    onKey(key('escape'), p.cx, undefined)
    p.state.completion = false
    onKey(key('escape'), p.cx, undefined)
    expect(p.log).toHaveLength(2)
  })
})

describe('KEYS', () => {
  it('matches the modifiers each shortcut needs and refuses those it must not have', () => {
    expect(matches(key('tab', { shift: true }), KEYS.effort)).toBe(true)
    expect(matches(key('tab'), KEYS.effort)).toBe(false)
    expect(matches(key('up', { alt: true, shift: true }), KEYS.dequeue)).toBe(true)
    expect(matches(key('p', { alt: true, meta: true }), KEYS.prs)).toBe(false)
  })

  it('are the shortcuts the help sheet lists', () => {
    const listed = HOTKEYS.flatMap(g => g.rows.flatMap(([keys]) => keys))

    for (const match of Object.values(KEYS)) {
      expect(listed).toContain(match.label)
    }

    // Each label names its key with its modifiers, as the help sheet writes them.
    for (const match of Object.values(KEYS)) {
      expect(match.label.split(' ')[0]).toBe([...match.with, match.name].join('+'))
    }
  })
})

describe('the Tern actions', () => {
  function actions(modal = false) {
    const log: string[] = []
    const cx: ActionCx = {
      connect: {
        continue: ref => void log.push(`continue ${ref}`),
        open: (ref, name) => void log.push(`open ${ref} ${name}`)
      },
      focusComposer: () => void log.push('focus'),
      modal: () => modal,
      openAgent: id => void log.push(`agent ${id}`),
      openProcess: id => void log.push(`process ${id}`),
      openUrl: url => void log.push(`url ${url}`)
    }

    return { cx, log }
  }

  const action = (act: string, value?: string) => ({ act, ev: 'action' as const, id: 'n', raw: {}, sf: 'hermes', ...(value === undefined ? {} : { value }) })

  it('each run their handler with the value', () => {
    const { cx, log } = actions()

    onTernEvent(action('open-agent', 'a1'), cx)
    onTernEvent(action('open-process', 'p1'), cx)
    onTernEvent(action('open-url', 'https://x.test'), cx)
    onTernEvent(action('connect-continue', 'card-1'), cx)
    onTernEvent(action('connect-open', 'call:1:github'), cx)
    expect(log).toEqual(['agent a1', 'process p1', 'url https://x.test', 'continue card-1', 'open call:1 github'])
    expect(Object.keys(ACTIONS).sort()).toEqual(['connect-continue', 'connect-open', 'open-agent', 'open-process', 'open-url'])
  })

  it('do nothing without a value, or for an act with no handler', () => {
    const { cx, log } = actions()

    onTernEvent(action('open-agent'), cx)
    onTernEvent(action('open-agent', ''), cx)
    onTernEvent(action('toString', 'x'), cx)
    onTernEvent(action('select', 'x'), cx)
    expect(log).toEqual([])
  })

  it('give the composer the keys back when its input takes the focus, unless a modal sheet is up', () => {
    const focus = (id: string) => ({ ev: 'focus' as const, id, raw: {}, sf: 'hermes' })
    const open = actions()

    onTernEvent(focus(INPUT_ID), open.cx)
    onTernEvent(focus('other'), open.cx)
    expect(open.log).toEqual(['focus'])

    const modal = actions(true)

    onTernEvent(focus(INPUT_ID), modal.cx)
    expect(modal.log).toEqual([])
  })
})

describe('commandEnvelope', () => {
  it('reads the dispatch union, and the bare output and warning of an older backend', () => {
    expect(commandEnvelope({ output: 'hi', type: 'exec', warning: 'careful' })).toEqual({
      dispatch: { output: 'hi', type: 'exec' },
      output: 'hi',
      warning: 'careful'
    })
    expect(commandEnvelope({ output: 'legacy' })).toEqual({ dispatch: null, output: 'legacy', warning: undefined })
  })

  it('leaves out what is not an object or not a string', () => {
    for (const raw of [null, undefined, 'text', 42, false]) {
      expect(commandEnvelope(raw)).toEqual({ dispatch: null, output: undefined, warning: undefined })
    }

    expect(commandEnvelope({ output: 3, warning: { text: 'x' } })).toEqual({ dispatch: null, output: undefined, warning: undefined })
  })
})

describe('sessionHost', () => {
  it('reads busy and queued when it is made, and the session live', async () => {
    const gw = new FakeGateway()
    let busy: Busy | null = { label: 'Working…', since: {}, startedAt: 0 }
    let queued = 2
    let ref = { live: liveSessionId('s1'), stored: storedSessionId('stored-1') }
    const resumed: string[] = []

    const cx: SessionHostCx = {
      activity: {
        get busy() {
          return busy
        }
      },
      changed: () => {},
      gw: gw.client,
      life: {
        reload: async () => undefined,
        resume: async id => {
          resumed.push(id)
          ref = { live: liveSessionId('s2'), stored: id }
        }
      },
      queue: { count: () => queued },
      router: { behind: () => {}, send: () => {} },
      setCompacting: () => {},
      state: {
        get ref() {
          return ref
        },
        ticket: () => ({ isCurrent: () => true, signal: new AbortController().signal, sid: ref.live }),
        usage: null
      },
      submit: () => {},
      transcript: { compacted: () => {}, compacting: () => {}, notice: () => {}, panel: () => {}, steer: () => {}, uncompact: () => {} }
    }

    const host = sessionHost(cx)

    busy = null
    queued = 0
    expect(host.busy).toBe(true)
    expect(host.queued).toBe(2)
    expect(host.sid).toBe('s1')
    await expect(host.open(storedSessionId('stored-2'))).resolves.toBe(true)
    expect(resumed).toEqual(['stored-2'])
    expect(sessionHost(cx).busy).toBe(false)
  })
})
