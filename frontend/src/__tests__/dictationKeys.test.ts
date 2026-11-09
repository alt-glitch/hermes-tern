// Keep dictation's key regressions separate from keys.test.ts at its 600-line size ceiling.
// This covers the split action base's existing modal, live voice and double-Escape ownership.
import { node } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { KEY_RULES, type KeyCx, onKey } from '../draft/keys.js'
import type { Overlay } from '../overlays/overlay.js'

import { key } from './fakes.js'

function pane() {
  let text = 'keep draft'
  const calls: string[] = []
  const cx: KeyCx = {
    attachClipboardImage: () => undefined,
    attachments: {
      any: false,
      clear: () => undefined,
      clearAll: () => void calls.push('clear images'),
      paste: () => false
    },
    busy: () => true,
    close: () => undefined,
    completion: { onKey: () => false },
    composer: {
      key: () => null,
      set: value => {
        text = value
        calls.push('clear draft')
      },
      take: () => {
        const old = text
        text = ''
        calls.push('take draft')
        return old
      },
      get text() { return text }
    },
    copyDraft: () => undefined,
    cycleEffort: () => undefined,
    dictation: {
      cancel: () => {
        calls.push('cancel capture')
        return true
      },
      onKey: pressed => {
        if (pressed.name !== 'escape') return false
        calls.push('dictation escape')
        return true
      }
    },
    fork: () => undefined,
    hud: () => false,
    interrupt: () => void calls.push('interrupt'),
    liveVoice: { blocked: false, toggle: () => undefined, control: async () => undefined, quickToggle: () => undefined },
    now: () => 10_000,
    openAgents: () => undefined,
    openBackground: () => undefined,
    openBrowserBlocks: () => undefined,
    openExternalEditor: () => undefined,
    openPrs: () => undefined,
    openPlan: () => undefined,
    presses: { esc: 0, exit: 0 },
    queue: { count: () => 0, dequeue: () => undefined, steer: () => undefined },
    quit: () => void calls.push('quit'),
    submitDraft: () => void calls.push('send'),
    steerDraft: () => undefined,
    toggleSidebar: () => undefined,
    transcript: { notice: () => undefined }
  }
  return { calls, cx, draft: () => text }
}

describe('dictation key precedence on the split actions base', () => {
  it('runs under modal ownership, before live and composer shortcuts', () => {
    const names = KEY_RULES.map(rule => rule.name)
    expect(names.indexOf('dictation')).toBe(names.indexOf('modal') + 1)
    expect(names.indexOf('dictation')).toBeLessThan(names.indexOf('liveKeys'))
    expect(names.indexOf('dictation')).toBeLessThan(names.indexOf('doubleEsc'))
  })

  it('Ctrl+C cancels a capture instead of clearing the draft or interrupting the turn', () => {
    const { calls, cx, draft } = pane()
    onKey(key('c', { ctrl: true }), cx, undefined)
    expect(calls).toEqual(['cancel capture'])
    expect(draft()).toBe('keep draft')
  })

  it('a modal takes Escape; otherwise dictation takes Escape without double-Escape draft loss', () => {
    const { calls, cx, draft } = pane()
    const top: Overlay = { key: 'modal', modal: true, node: () => node('box', { key: 'modal' }), onKey: () => false }
    onKey(key('escape'), cx, top)
    expect(calls).toEqual([])
    onKey(key('escape'), cx, undefined)
    onKey(key('escape'), cx, undefined)
    expect(calls).toEqual(['dictation escape', 'dictation escape'])
    expect(draft()).toBe('keep draft')
  })
})
