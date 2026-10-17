import { describe, expect, it } from 'vitest'

import { COMPACTING_LABEL, isLoginNotice, Notices, statusEffect } from '../status.js'

describe('statusEffect', () => {
  // The kinds the shared gateway sends (gateway/run_turn_progress.py _viewer_status_kind, run_goals.py).
  it('labels the working line with lifecycle lines', () => {
    expect(statusEffect({ kind: 'lifecycle', text: '⏳ Rate limited, retrying in 5s' })).toEqual({
      label: '⏳ Rate limited, retrying in 5s'
    })
    expect(statusEffect({ kind: 'status', text: 'Thinking' })).toEqual({ label: 'Thinking' })
  })

  it('shows compaction in the transcript and holds the label until the done edge', () => {
    expect(statusEffect({ kind: 'compacting', text: '📦 Pre-API compression: compacting' })).toEqual({
      compacting: true,
      label: COMPACTING_LABEL,
      notice: { text: '📦 Pre-API compression: compacting', tone: 'info' }
    })
    expect(statusEffect({ kind: 'compacted', text: 'Compaction complete' })).toEqual({
      compacting: false,
      label: 'Compaction complete'
    })
  })

  it('puts warnings in the transcript once', () => {
    const first = statusEffect({ kind: 'warn', text: 'Memory provider unavailable' })

    expect(first).toEqual({
      note: 'Memory provider unavailable',
      notice: { text: 'Memory provider unavailable', tone: 'warning' }
    })
    expect(statusEffect({ kind: 'warn', text: 'Memory provider unavailable' }, first.note)).toEqual({})
    expect(statusEffect({ kind: 'error', text: 'boom' }, first.note).notice).toEqual({ text: 'boom', tone: 'error' })
  })

  it("shows a goal verdict as a transcript line", () => {
    expect(statusEffect({ kind: 'goal', text: '✓ Goal met' }).notice).toEqual({ text: '✓ Goal met', tone: 'success' })
    expect(statusEffect({ kind: 'goal', text: '↻ Continuing toward the goal' }).notice?.tone).toBe('info')
  })

  it('ignores an empty line', () => {
    expect(statusEffect({ kind: 'warn', text: '  ' })).toEqual({})
    expect(statusEffect(undefined)).toEqual({})
  })
})

describe('Notices', () => {
  it('replaces by key and shows the newest', () => {
    const n = new Notices()

    n.show({ key: 'credits.usage', kind: 'sticky', level: 'warn', text: "⚠ You've used $8.00 of your $10 cap" })
    n.show({ key: 'credits.depleted', kind: 'sticky', level: 'error', text: '✕ Credit access paused · run /topup' })
    expect(n.current()).toMatchObject({ key: 'credits.depleted', tone: 'error' })

    n.show({ key: 'credits.usage', kind: 'sticky', level: 'info', text: "• You've used $9.00 of your $10 cap" })
    expect(n.current()).toMatchObject({ key: 'credits.usage', text: "• You've used $9.00 of your $10 cap", tone: 'info' })
  })

  it('clears only a matching key', () => {
    const n = new Notices()

    n.show({ key: 'credits.depleted', kind: 'sticky', level: 'error', text: '✕ paused' })
    expect(n.clear('credits.usage')).toBe(false)
    expect(n.current()?.key).toBe('credits.depleted')
    expect(n.clear('credits.depleted')).toBe(true)
    expect(n.current()).toBeUndefined()
  })

  it('expires a ttl notice and falls back to the one under it', () => {
    const n = new Notices()

    n.show({ key: 'credits.usage', kind: 'sticky', level: 'warn', text: '⚠ used' }, 0)
    n.show({ key: 'credits.restored', kind: 'ttl', level: 'success', text: '✓ restored', ttl_ms: 5000 }, 0)
    expect(n.nextExpiry()).toBe(5000)
    expect(n.current(4999)).toMatchObject({ key: 'credits.restored', tone: 'success' })
    expect(n.current(5000)?.key).toBe('credits.usage')
    expect(n.nextExpiry()).toBeUndefined()
  })

  it('tells /login steps apart', () => {
    expect(isLoginNotice({ key: 'login:ab12cd34', text: 'Open https://portal.example/device · code ABCD-1234' })).toBe(true)
    expect(isLoginNotice({ key: 'credits.usage', text: 'x' })).toBe(false)
  })
})
