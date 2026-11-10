import { expect, it } from 'vitest'

import { entryId } from '../core/ids.js'
import { PATCH_CONTEXT_WARNING } from '../tools/patch-warning.js'
import { history } from '../transcript/history.js'
import { entryNode } from '../view/transcript.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { tree } from './fakes.js'
import { call } from './toolFixtures.js'

const secret = '/backend/private/x.py'
const scenarios = [
  { name: 'ordinary failure', args: { mode: 'replace', path: 'x.py', old_string: 'a', new_string: 'b' },
    result: { success: false, _warning: 'private warning', error: `patch failed: ${secret}`, resolved_path: secret }, expected: 'Patch failed' },
  { name: 'validation refusal', args: { mode: 'patch', patch: '*** Begin Patch\n*** End Patch' },
    result: { success: false, _warning: 'private warning', error: `Patch validation failed (no files were modified):\nUnable to find ${secret}` }, expected: 'Patch validation failed (no files were modified)' },
  { name: 'partial apply failure', args: { mode: 'patch', patch: '*** Begin Patch\n*** End Patch' },
    result: { success: false, _warning: 'private warning', error: `Apply phase failed (state may be inconsistent — run \`git diff\` to assess):\nUnable to write ${secret}` }, expected: 'state may be inconsistent' }
]

it.each(scenarios)('does not expose backend error paths on warned $name', ({ args, result, expected }) => {
  const c = call('patch', args, { result, outcome: { kind: 'error', duration: 1 } })
  for (const hostLocal of [false, true]) {
    const node = tree(toolNode(c, 0, undefined, undefined, undefined, { cwd: '/repo', hostLocal, media: true }))
    expect(node.p?.['status']).toBe('error')
    const rendered = JSON.stringify(node)
    expect(rendered).toContain(PATCH_CONTEXT_WARNING)
    expect(rendered).toContain(expected)
    expect(rendered).not.toContain(secret)
    expect(rendered).not.toContain('private warning')
  }
  const detail = JSON.stringify(toolDetail(c, 0).map(tree))
  expect(detail).toContain(expected)
  expect(detail).not.toContain(secret)
})

it('retains original failure details when no warning is reported', () => {
  const c = call('patch', { mode: 'patch', patch: '*** Begin Patch\n*** End Patch' }, {
    result: { success: false, error: 'Patch validation failed (no files were modified):\nline 3 missing' },
    outcome: { kind: 'error', duration: 1 }
  })
  expect(JSON.stringify(tree(toolNode(c, 0)))).toContain('line 3 missing')
})

it('keeps warned validation failure and no-write disclosure on replay without the backend error', () => {
  const sample = scenarios[1]
  if (!sample) throw new Error('missing validation scenario')
  let n = 0
  const entries = history({ kept: [], id: p => entryId(`${p}${++n}`), messages: [
    { role: 'tool', name: 'patch', tool_call_id: 'patch-warning', args: sample.args, content: JSON.stringify(sample.result), is_error: true },
    { role: 'assistant', text: 'answer' }
  ] })
  const turn = entries.find(entry => entry.kind === 'turn')
  if (!turn || turn.kind !== 'turn') throw new Error('missing replay turn')
  const view = JSON.stringify(tree(entryNode(turn, 'main.patch-warning-privacy', { copy: () => undefined, now: 1000, welcome: { version: '' } })))
  expect(view).toContain('Patch validation failed (no files were modified)')
  expect(view).toContain(PATCH_CONTEXT_WARNING)
  expect(view).not.toContain(secret)
  expect(view).not.toContain('private warning')
})
