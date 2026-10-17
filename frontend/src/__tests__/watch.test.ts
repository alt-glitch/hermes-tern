import { describe, expect, it } from 'vitest'

import { Transcript } from '../transcript.js'
import { toTranscript } from '../watch/child.js'

describe('toTranscript', () => {
  it("turns a child's stored rows into a transcript with tool cards and results", () => {
    const rows = [
      { content: 'Survey the repo', id: 1, reasoning: null, role: 'user', timestamp: 1, tool_call_id: null, tool_calls: null, tool_name: null },
      {
        content: '',
        id: 2,
        reasoning: null,
        role: 'assistant',
        timestamp: 2,
        tool_call_id: null,
        tool_calls: JSON.stringify([{ function: { arguments: '{"command":"ls"}', name: 'terminal' }, id: 'c1' }]),
        tool_name: null
      },
      { content: '{"output":"lab"}', id: 3, reasoning: null, role: 'tool', timestamp: 3, tool_call_id: 'c1', tool_calls: null, tool_name: 'terminal' },
      { content: 'Done.', id: 4, reasoning: null, role: 'assistant', timestamp: 4, tool_call_id: null, tool_calls: null, tool_name: null }
    ]

    const t = new Transcript()
    t.load(toTranscript(rows))
    const [user, turn] = t.entries

    expect(user).toMatchObject({ kind: 'user', text: 'Survey the repo' })
    expect(turn?.kind).toBe('turn')
    const blocks = turn?.kind === 'turn' ? turn.blocks : []
    expect(blocks.map(b => b.kind)).toEqual(['tool', 'text'])
    expect(blocks[0]).toMatchObject({ call: { args: { command: 'ls' }, name: 'terminal', result: '{"output":"lab"}' } })
  })
})
