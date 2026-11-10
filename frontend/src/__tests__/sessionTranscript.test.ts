import type { StoredTranscriptRow } from '@hermes/shared/gateway-events'
import { describe, expect, it } from 'vitest'

import { compactionOf, gatewayTranscripts, previewRows } from '../hermes/sessionTranscript.js'

import { FakeGateway } from './fakes.js'

const message = (row: Partial<StoredTranscriptRow> & Pick<StoredTranscriptRow, 'role'>): StoredTranscriptRow => ({ row_kind: 'message', ...row })

const handoff: StoredTranscriptRow = { compacted_messages: 41, role: 'system', row_id: 7, row_kind: 'compaction', text: '## Goal\nShip it.', timestamp: 200 }

describe('previewRows', () => {
  it('shows prompts, replies, a tool call per line, notices and failures, and leaves system rows out', () => {
    const rows = [
      message({ role: 'user', row_id: 1, text: 'Fix the build' }),
      message({ args: { path: 'src/app.ts' }, name: 'read_file', role: 'tool', tool_call_id: 'c1' }),
      message({ display_kind: 'steer', role: 'user', row_id: 2, text: 'also run the tests' }),
      message({ display_kind: 'process_complete', role: 'user', row_id: 3, text: '[SYSTEM: Background process completed]\nexit 0' }),
      message({ display_kind: 'failed_turn', role: 'assistant', row_id: 4, text: 'Provider error\nmore' }),
      message({ role: 'assistant', row_id: 5, text: 'Done.' }),
      message({ role: 'system', row_id: 6, text: 'a system line' })
    ].flatMap(previewRows)

    expect(rows).toEqual([
      { key: 'row1', kind: 'user', steer: false, text: 'Fix the build' },
      { args: { path: 'src/app.ts' }, key: 'tool||c1', kind: 'tool', name: 'read_file' },
      { key: 'row2', kind: 'user', steer: true, text: 'also run the tests' },
      { key: 'row3', kind: 'note', text: 'Background process completed', tone: 'muted' },
      { key: 'row4', kind: 'note', text: 'Provider error', tone: 'error' },
      { key: 'row5', kind: 'assistant', text: 'Done.' }
    ])
  })

  it('shows a compaction row as a note with the messages it covers', () => {
    expect(previewRows(handoff)).toEqual([{ key: 'row7', kind: 'note', text: 'Context compacted (41 messages): the agent continued from a summary.', tone: 'muted' }])
  })
})

describe('compactionOf', () => {
  it('reads a compaction row as its time, summary and count, and nothing else', () => {
    expect(compactionOf(handoff)).toEqual({ at: 200_000, messages: 41, summary: '## Goal\nShip it.' })
    expect(compactionOf({ ...handoff, timestamp: null })).toBeUndefined()
    expect(compactionOf(message({ role: 'user', text: '[CONTEXT COMPACTION] looks like one' }))).toBeUndefined()
  })
})

describe('gatewayTranscripts', () => {
  it('reads newest first with the cursor it was given, and shows a page newest line first', async () => {
    const gw = new FakeGateway({
      replies: {
        'session.transcript': () => ({
          next_cursor: 'older',
          reset: false,
          rows: [message({ role: 'user', row_id: 1, text: 'one' }), message({ role: 'assistant', row_id: 2, text: 'two' })],
          session_id: 's'
        })
      }
    })

    const page = await gatewayTranscripts(gw.client).page('s', 'cur', 40)

    expect(gw.sent('session.transcript')).toEqual([{ cursor: 'cur', limit: 40, order: 'latest', session_id: 's' }])
    expect(page).toEqual({
      next: 'older',
      reset: false,
      rows: [
        { key: 'row2', kind: 'assistant', text: 'two' },
        { key: 'row1', kind: 'user', steer: false, text: 'one' }
      ]
    })
  })
})
