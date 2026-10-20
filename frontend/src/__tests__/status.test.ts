import { describe, expect, it } from 'vitest'

import { COMPACTING_LABEL, statusEffect } from '../status.js'

describe('statusEffect', () => {
  // The kinds the shared gateway sends (gateway/run_turn_progress.py _viewer_status_kind, run_goals.py).
  it('labels the working line with lifecycle lines', () => {
    expect(statusEffect({ kind: 'lifecycle', text: '⏳ Rate limited, retrying in 5s' })).toEqual({
      label: '⏳ Rate limited, retrying in 5s'
    })
    expect(statusEffect({ kind: 'status', text: 'Thinking' })).toEqual({ label: 'Thinking' })
  })

  it('drives the compaction rule (no notice line) and holds the label until the done edge', () => {
    expect(statusEffect({ kind: 'compacting', text: '📦 Pre-API compression: compacting' })).toEqual({
      compacting: true,
      label: COMPACTING_LABEL
    })
    expect(statusEffect({ kind: 'compacted', text: 'Compaction complete' })).toEqual({
      compacting: false,
      label: 'Compaction complete'
    })
  })

  it("reads the token counts of Hermes' compaction lines", () => {
    const preflight = '📦 Preflight compression: ~182,000 tokens >= 160,000 threshold. This may take a moment.'
    expect(statusEffect({ kind: 'compacting', text: preflight }).tokens).toEqual({ before: 182000 })
    expect(statusEffect({ kind: 'compressing', text: '⠋ compressing 120 messages (~95,400 tok)…' }).tokens).toEqual({ before: 95400 })
    expect(statusEffect({ kind: 'compacting', text: '🗜️ Compressed ~250,000 → ~120,000 tokens, retrying...' }).tokens).toEqual({
      after: 120000,
      before: 250000
    })
  })

  it("ends /compress's compaction on its bare ready edge", () => {
    expect(statusEffect({ kind: 'ready' })).toEqual({ compacting: false })
    expect(statusEffect({ kind: 'lifecycle' })).toEqual({})
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
