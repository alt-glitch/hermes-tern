import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { patchLintNeedsAttention } from '../tools/patch-lint-attention.js'
import { v4aLintNeedsAttention } from '../tools/v4a-lint.js'
import { history } from '../transcript/history.js'
import { Transcript } from '../transcript/store.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { actionOf, foldOf, parts, pieces, stepLabel, summarize } from '../view/workLogModel.js'
import { parseJson, record } from '../wire/json.js'
import { stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const label = 'Environment recreated; state may be lost'
const notice = 'Hermes reports the execution environment was recreated; background processes and unpersisted files may be lost.'
const tool = (id: string, c: ToolCall): Extract<Block, { kind: 'tool' }> => ({ kind: 'tool', id: entryId(id), call: c })
const text = (id: string): Block => ({ kind: 'text', id: entryId(id), text: id })
const turn = (blocks: Block[]): TurnEntry => ({ kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks })
const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const make = (result: unknown, more: Partial<ToolCall> = {}) => call('terminal', { command: 'true' }, { result, ...more })

function producer(): { flagged: Record<string, unknown>; clean: Record<string, unknown>; failed: Record<string, unknown>; cancelled: Record<string, unknown> } {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/terminal-recreated-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const data = parseJson(raw)
  if (!Array.isArray(data)) throw new Error('expected producer results')
  const flagged = record(data[0])
  const clean = record(data[1])
  const failed = record(data[2])
  const cancelled = record(data[3])
  if (!flagged || !clean || !failed || !cancelled) throw new Error('expected terminal objects')
  return { flagged, clean, failed, cancelled }
}

function writeProducer(): Record<string, unknown> {
  const script = `from tools.file_operations_lint import LintMixin
from tools.file_operations_common import WriteResult
import json
lint = LintMixin()._check_lint_delta('x.py','x = 1\\n','def broken(:\\n    pass\\n').to_dict()
print(json.dumps(WriteResult(bytes_written=23,verified=True,lint=lint).to_dict()))`
  const result = record(execFileSync('python3', ['-c', script], { cwd: resolve('.hermes-src'), encoding: 'utf8' }))
  if (!result) throw new Error('expected write object')
  return result
}

function patchProducer(): Record<string, unknown> {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/patch-lint-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const data = parseJson(raw)
  if (!Array.isArray(data)) throw new Error('expected replace producer results')
  const result = record(data[0])
  if (!result) throw new Error('expected replace patch object')
  return result
}

function v4aProducer(): Record<string, unknown>[] {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/v4a-lint-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const data = parseJson(raw)
  if (!Array.isArray(data)) throw new Error('expected V4A producer results')
  return data.map(value => { const result = record(value); if (!result) throw new Error('invalid V4A result'); return result })
}

function noLintGateway(): Record<string, unknown>[] {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/v4a-failure-no-lint.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const data = parseJson(raw)
  if (!Array.isArray(data)) throw new Error('expected gateway payloads')
  return data.map(value => { const result = record(value); if (!result) throw new Error('invalid gateway payload'); return result })
}

function fixture(name: string): unknown {
  return parseJson(execFileSync('python3', [resolve(`src/__tests__/fixtures/${name}`)], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src'), PYTHONDONTWRITEBYTECODE: '1' }
  }))
}

describe('retained terminal recreation attention', () => {
  // Five isolated pinned Python producers can exceed Vitest's 5s default under CI load.
  // Synchronous subprocesses cannot be interrupted by this timer; CI bounds the whole job.
  it('keeps actual write refusal, terminal advisories and staged memory beside existing attention', () => {
    const refusalPayload = record(fixture('write-refusal-core.py'))
    const memories = fixture('memory-staged-core.py')
    const terminals = fixture('terminal-masked-core.py')
    const skills = fixture('skill-stub-core.py')
    if (!refusalPayload || !Array.isArray(memories) || !Array.isArray(terminals) || !Array.isArray(skills)) throw new Error('missing producer fixtures')
    const memoryPayload = record(memories[0])
    const both = record(terminals[2])
    const skillResult = record(skills[0])
    if (!memoryPayload || !both || !skillResult) throw new Error('missing producer results')
    const transcript = new Transcript()
    transcript.toolComplete(stub(refusalPayload), 10)
    transcript.toolComplete(stub(memoryPayload), 11)
    const refused = transcript.call(toolCallId(String(refusalPayload['tool_id'])))
    const staged = transcript.call(toolCallId(String(memoryPayload['tool_id'])))
    if (!refused || !staged) throw new Error('missing live calls')
    const noop = tool('noop', call('patch', { path: 'old.py' }, { result: { success: true, no_change: true } }))
    const skill = tool('skill', call('skill_view', { name: 'example' }, { result: skillResult }))
    const write = tool('refused', refused)
    const terminal = tool('terminal', call('terminal', { command: 'npm test | tail' }, { result: both }))
    const memory = tool('memory', staged)
    const web = tool('web', call('web_extract', {}, { result: { results: [{ error: 'invalid URL' }] } }))
    const evaluation = tool('eval', call('execute_code', {}, { result: { stdout_truncated: true, output: 'partial' } }))
    const partial = tool('partial', call('patch', { mode: 'patch', patch: '*** Begin Patch\n*** End Patch' }, { result: v4aProducer()[1], outcome: { kind: 'error', duration: 1 } }))
    const t = turn([noop, skill, write, terminal, memory, web, partial, evaluation, text('answer')])
    expect(parts(t).flatMap(part => part.blocks.map(block => block.id))).toEqual(['noop', 'skill', 'refused', 'terminal', 'memory', 'web', 'partial', 'eval', 'answer'])
    expect([write, terminal, memory, web, partial, evaluation].map(block => foldOf(t)?.hidden.has(block.id))).toEqual([false, false, false, false, false, false])
    for (const block of [write, terminal, memory]) expect(pieces([block])).toEqual([{ kind: 'block', block }])
    const root = tree(entryNode(t, 'main.batch', cx))
    const cards = nodes(root).filter(node => node.k === 'tool')
    const writeCard = cards.find(node => node.p?.['name'] === 'write' && JSON.stringify(node).includes('NOT created or modified'))
    const terminalCard = cards.find(node => node.p?.['name'] === 'bash' && JSON.stringify(node).includes('exit 0 may mask'))
    const memoryCard = cards.find(node => node.p?.['name'] === 'memory')
    expect(writeCard?.p).toMatchObject({ status: 'error', collapsed: false })
    expect(terminalCard?.p).toMatchObject({ status: 'done', collapsed: false, exit: 0 })
    expect(memoryCard?.p).toMatchObject({ status: 'done', collapsed: false })
    const rendered = JSON.stringify(root)
    for (const value of ['Candidate content; write refused', 'NOT created or modified', 'exit 0 may mask', notice,
      'memory change was staged for approval', 'Target text appears present; no write performed',
      'skill view is unchanged; content was not returned', 'Extraction failed: invalid URL', 'Hermes reports stdout was truncated']) expect(rendered).toContain(value)
    expect(rendered.split('NOT created or modified')).toHaveLength(2)
    expect(rendered).toContain('Lint reported an error for x.py')
    expect(partial.call.outcome.kind).toBe('error')
  }, 20_000)
  it('shows the real finalizer warning on an unfolded card before the answer without changing the result', () => {
    const { flagged } = producer()
    const warned = tool('warned', make(flagged))
    const t = turn([tool('before', make({ output: 'before', exit_code: 0, error: null })), warned, tool('after', make({ output: 'after', exit_code: 0, error: null })), text('answer')])
    expect(foldOf(t)?.hidden.has(warned.id)).toBe(false)
    expect(parts(t).map(p => `${p.kind}:${p.blocks.map(b => b.id).join(',')}`)).toEqual(['fold:before', 'shown:warned', 'fold:after', 'shown:answer'])
    expect(pieces([warned], t.blocks)).toEqual([{ kind: 'block', block: warned }])
    const cards = nodes(tree(entryNode(t, 'main.terminal', cx))).filter(n => n.k === 'tool' && n.p?.['name'] === 'bash')
    const card = cards.find(n => Array.isArray(n.p?.['meta']) && n.p['meta'].includes(label))
    expect(card?.p).toMatchObject({ status: 'done', collapsed: false, meta: [label] })
    expect(JSON.stringify(card)).toContain(notice)
    expect(warned.call.result).toBe(flagged)
    expect(warned.call.outcome.kind).toBe('done')
  })

  it('preserves web, eval, delegate, error and running attention and their order', () => {
    const { flagged } = producer()
    const web = tool('web', call('web_extract', {}, { result: { results: [{ error: 'invalid URL' }] } }))
    const evalBlock = tool('eval', call('execute_code', { code: 'print(1)' }, { result: { stdout_truncated: true, output: 'partial' } }))
    const task = tool('task', call('delegate_task', {}, { result: { results: [{ status: 'completed', exit_reason: 'max_iterations', truncated: true, summary: 'partial' }] } }))
    const warned = tool('warned', make(flagged))
    const failed = tool('failed', call('terminal', {}, { outcome: { kind: 'error', duration: 1 } }))
    const running = tool('running', call('terminal', {}, { outcome: { kind: 'running' } }))
    const t = turn([tool('before', make({})), web, evalBlock, task, warned, failed, text('answer'), running])
    expect(parts(t).flatMap(p => p.blocks.map(b => b.id))).toEqual(['before', 'web', 'eval', 'task', 'warned', 'failed', 'answer', 'running'])
    expect([web, evalBlock, task, warned, failed, running].map(b => foldOf(t)?.hidden.has(b.id))).toEqual([false, false, false, false, false, false])
    const root = tree(entryNode(t, 'main.combined', cx))
    expect(nodes(root).some(node => node.k === 'tool' && node.p?.['name'] === 'fetch')).toBe(true)
    for (const value of ['Hermes reports stdout was truncated', 'At least one delegated task reached its iteration limit', notice]) expect(JSON.stringify(root)).toContain(value)
  })

  it('keeps producer-backed terminal, write and replace-patch warnings visible with web, delegate and eval', () => {
    const { failed, cancelled } = producer()
    const transcript = new Transcript()
    transcript.messageStart()
    for (const [id, result] of [['fail', failed], ['cancel', cancelled]] as const) {
      transcript.toolStart({ args: { command: 'true' }, name: 'terminal', tool_id: id })
      transcript.toolComplete({ name: 'terminal', result, tool_id: id })
    }
    const [failedCall, cancelledCall] = transcript.calls('terminal')
    if (!failedCall || !cancelledCall) throw new Error('missing terminal calls')
    expect(failedCall.outcome.kind).toBe('error')
    expect(cancelledCall.outcome.kind).toBe('cancelled')
    const noop = tool('noop', call('patch', { path: 'old.py' }, { result: { success: true, no_change: true } }))
    const web = tool('web', call('web_extract', {}, { result: { results: [{ error: 'invalid URL' }] } }))
    const task = tool('task', call('delegate_task', {}, { result: { results: [{ status: 'completed', exit_reason: 'max_iterations', truncated: true, summary: 'partial' }] } }))
    const evalBlock = tool('eval', call('execute_code', {}, { result: { stdout_truncated: true, output: 'partial' } }))
    const write = tool('write', call('write_file', { path: 'x.py', content: 'def broken(:\n    pass\n' }, { result: writeProducer() }))
    const patch = tool('patch', call('patch', { path: 'x.py', old_string: 'x = 1', new_string: 'def broken(:' }, { result: patchProducer() }))
    // A partial V4A failure is outside the successful-result diagnostic slice.
    const v4a = tool('v4a', call('patch', { mode: 'patch', patch: '*** Begin Patch\n*** End Patch' }, { result: { success: false, lint: { 'x.py': { status: 'error', output: 'not a replace report' } } } }))
    const error = tool('error', failedCall)
    const cancel = tool('cancel', cancelledCall)
    const changed = tool('changed', call('patch', { path: 'new.py' }, { result: { success: true, diff: '@@ -1 +1 @@\n-old\n+new' } }))
    const t = turn([noop, web, task, evalBlock, write, patch, error, cancel, v4a, changed, text('answer')])
    expect(parts(t).flatMap(part => part.blocks.map(block => block.id)))
      .toEqual(['noop', 'web', 'task', 'eval', 'write', 'patch', 'error', 'cancel', 'v4a', 'changed', 'answer'])
    expect([web, task, evalBlock, write, patch, error, cancel].map(block => foldOf(t)?.hidden.has(block.id)))
      .toEqual([false, false, false, false, false, false, false])
    expect(foldOf(t)?.hidden.has(v4a.id)).toBe(true)
    expect(patchLintNeedsAttention(v4a.call)).toBe(false)
    expect(actionOf(noop.call)).toBe('other')
    expect(stepLabel(noop.call)).toBe('Patch target appears present in old.py')
    expect(summarize([noop, changed])).toBe('Used 1 tool and changed 1 file')
    const root = tree(entryNode(t, 'main.combined-pair', cx))
    const cards = nodes(root).filter(node => node.k === 'tool')
    const webCard = cards.find(node => node.p?.['name'] === 'fetch')
    const taskCard = cards.find(node => node.p?.['name'] === 'task')
    const evalCard = cards.find(node => node.p?.['name'] === 'eval')
    const writeCard = cards.find(node => node.p?.['name'] === 'write')
    const patchCard = cards.find(node => node.p?.['name'] === 'edit' && JSON.stringify(node).includes('SyntaxError'))
    const terminals = cards.filter(node => node.p?.['name'] === 'bash' && Array.isArray(node.p['meta']) && node.p['meta'].includes(label))
    for (const card of [webCard, taskCard, evalCard, writeCard, patchCard]) expect(card?.p).toMatchObject({ status: 'done', collapsed: false })
    expect(terminals.map(card => card.p?.['status'])).toEqual(['error', 'cancelled'])
    for (const card of terminals) expect(JSON.stringify(card)).toContain(notice)
    expect(JSON.stringify(webCard)).toContain('Extraction failed: invalid URL')
    expect(JSON.stringify(taskCard)).toContain('At least one delegated task reached its iteration limit')
    expect(JSON.stringify(evalCard)).toContain('Hermes reports stdout was truncated')
    expect(JSON.stringify(writeCard)).toContain('SyntaxError')
    expect(JSON.stringify(patchCard)).toContain('Lint reported an error')
    expect(JSON.stringify(patchCard)).toContain('def broken(:')
    expect(JSON.stringify(root)).not.toContain('not a replace report')
    expect(JSON.stringify(root)).toContain('Target text appears present; no write performed')
    expect(JSON.stringify(root)).not.toContain('changed 2 files')
  })

  it('keeps settled error and cancellation statuses while showing their warning', () => {
    const { flagged } = producer()
    for (const outcome of [{ kind: 'error' as const, duration: 1 }, { kind: 'cancelled' as const, duration: 1 }]) {
      const warned = tool('warned', make(flagged, { outcome }))
      const t = turn([tool('before', make({})), warned, text('answer')])
      expect(foldOf(t)?.hidden.has(warned.id)).toBe(false)
      expect(pieces([warned])).toEqual([{ kind: 'block', block: warned }])
      const card = nodes(tree(entryNode(t, 'main.settled', cx))).find(n => n.k === 'tool' && n.p?.['name'] === 'bash' && Array.isArray(n.p?.['meta']))
      expect(card?.p).toMatchObject({ status: outcome.kind, collapsed: false, meta: [label] })
      expect(JSON.stringify(card)).toContain(notice)
      expect(warned.call.outcome).toEqual(outcome)
    }
  })

  it('shows V4A success, partial failure and bounded omissions with other retained attention', () => {
    const [result, partial] = v4aProducer()
    const { flagged } = producer()
    const args = { mode: 'patch', patch: '*** Begin Patch\n*** End Patch' }
    const noop = tool('noop', call('patch', { path: 'old.py' }, { result: { success: true, no_change: true } }))
    const web = tool('web', call('web_extract', {}, { result: { results: [{ error: 'invalid URL' }] } }))
    const write = tool('write', call('write_file', { path: 'w.py', content: 'def broken(:\n    pass\n' }, { result: writeProducer() }))
    const replace = tool('replace', call('patch', { path: 'x.py', old_string: 'x = 1', new_string: 'def broken(:' }, { result: patchProducer() }))
    const v4a = tool('v4a', call('patch', args, { result }))
    const lint = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`file${i}.py`, { status: 'ok', output: '' }]))
    const omitted = tool('omitted', call('patch', args, { result: { success: true, lint } }))
    const warned = tool('warned', make(flagged))
    const failed = tool('partial', call('patch', args, { result: partial, outcome: { kind: 'error', duration: 1 } }))
    const evalBlock = tool('eval', call('execute_code', {}, { result: { stdout_truncated: true, output: 'partial' } }))
    const transcript = new Transcript()
    const noLintCalls = noLintGateway().map(payload => {
      transcript.toolComplete(stub(payload), 10)
      const c = transcript.call(toolCallId(String(payload['tool_id'])))
      if (!c) throw new Error('missing gateway call')
      expect(c.outcome.kind).toBe('error')
      return c
    })
    const noLint = noLintCalls.map((c, index) => tool(index ? 'clean-lint' : 'absent-lint', c))
    const t = turn([noop, web, write, replace, v4a, omitted, warned, failed, ...noLint, evalBlock, text('answer')])
    expect(parts(t).flatMap(part => part.blocks.map(block => block.id)))
      .toEqual(['noop', 'web', 'write', 'replace', 'v4a', 'omitted', 'warned', 'partial', 'absent-lint', 'clean-lint', 'eval', 'answer'])
    expect([web, write, replace, v4a, omitted, warned, failed, ...noLint, evalBlock].map(block => foldOf(t)?.hidden.has(block.id)))
      .toEqual([false, false, false, false, false, false, false, false, false, false])
    expect(v4aLintNeedsAttention(failed.call)).toBe(true)
    expect(actionOf(noop.call)).toBe('other')
    expect(stepLabel(noop.call)).toBe('Patch target appears present in old.py')
    const root = tree(entryNode(t, 'main.v4a-combined', cx))
    const cards = nodes(root).filter(node => node.k === 'tool')
    const v4aCard = cards.find(node => node.p?.['name'] === 'edit' && JSON.stringify(node).includes('Lint reported an error for x.py'))
    const omittedCard = cards.find(node => node.p?.['name'] === 'edit' && JSON.stringify(node).includes('Additional lint entries were not inspected'))
    const warningCard = cards.find(node => node.p?.['name'] === 'bash' && JSON.stringify(node).includes(notice))
    const writeCard = cards.find(node => node.p?.['name'] === 'write')
    const replaceCard = cards.find(node => node.p?.['name'] === 'edit' && JSON.stringify(node).includes('SyntaxError') && node !== v4aCard)
    const partialCard = cards.find(node => node.p?.['name'] === 'edit' && node.p?.['status'] === 'error')
    for (const card of [v4aCard, omittedCard, warningCard, writeCard, replaceCard]) expect(card?.p).toMatchObject({ status: 'done', collapsed: false })
    expect(partialCard?.p).toMatchObject({ status: 'error', collapsed: false })
    if (!v4aCard) throw new Error('missing V4A card')
    if (!partialCard) throw new Error('missing partial V4A card')
    expect(nodes(v4aCard).every(node => node.p?.['href'] === undefined)).toBe(true)
    expect(JSON.stringify(omittedCard)).not.toContain('Lint reported an error')
    const rawError = record(partial)?.['error']
    expect(typeof rawError).toBe('string')
    expect(nodes(partialCard).filter(node => node.p?.['role'] === 'omp.tool.error').map(node => node.p?.['spans']))
      .toEqual([[{ s: 'error', t: rawError }]])
    expect(JSON.stringify(partialCard)).toContain('Lint reported an error for x.py')
    expect(JSON.stringify(partialCard)).toContain('def broken(:')
    for (const c of noLintCalls) {
      const card = cards.find(node => node.p?.['key'] === c.id)
      if (!card) throw new Error('missing absent/clean lint card')
      expect(card.p).toMatchObject({ status: 'error', collapsed: false })
      const raw = record(c.result)?.['error']
      expect(nodes(card).filter(node => node.p?.['role'] === 'omp.tool.error').map(node => node.p?.['spans']))
        .toEqual([[{ s: 'error', t: raw }]])
      expect(JSON.stringify(card)).toContain('+x = 42')
      expect(JSON.stringify(card)).not.toContain('Lint reported an error')
    }
    expect(JSON.stringify(root)).toContain('Extraction failed: invalid URL')
    expect(JSON.stringify(root)).toContain('Hermes reports stdout was truncated')
    expect(JSON.stringify(root)).toContain('Target text appears present; no write performed')
    expect(failed.call.outcome.kind).toBe('error')
  })

  it('does not promote clean, malformed, running, or background results', () => {
    const { flagged, clean } = producer()
    const cases = [clean, { ...flagged, environment_recreated: true }, { ...flagged, environment_recreated: 'arbitrary' },
      { ...flagged, exit_code: '0' }, { ...flagged, output: null }, { ...flagged, error: 'error' },
      Object.assign(Object.create({ environment_recreated: flagged['environment_recreated'] }), { output: 'shown', exit_code: 0, error: null })]
    for (const result of cases) {
      const c = tool('ordinary', make(result))
      expect(foldOf(turn([c, text('answer')]))?.hidden.has(c.id)).toBe(true)
      expect(pieces([c])).toEqual([{ kind: 'work', items: [c] }])
    }
    const running = tool('running', make(flagged, { outcome: { kind: 'running' } }))
    expect(pieces([running])).toEqual([{ kind: 'work', items: [running] }])
    const background = tool('background', call('terminal', { command: 'true', background: true }, { result: flagged }))
    const session = tool('session', make({ ...flagged, session_id: 'pid' }))
    for (const b of [background, session]) {
      expect(pieces([b])).toEqual([{ kind: 'block', block: b }])
      const root = tree(entryNode(turn([b, text('answer')]), 'main.background', cx))
      expect(JSON.stringify(root)).not.toContain(notice)
      expect(JSON.stringify(root)).not.toContain(label)
    }
  })

  it('shows retained replay signals and leaves missing replay data folded', () => {
    const { flagged } = producer()
    const replay = (content?: string) => history({ kept: [], id: entryId, messages: [
      { role: 'tool', name: 'terminal', tool_call_id: 'term', args: { command: 'true' }, ...(content ? { content } : {}) },
      { role: 'assistant', text: 'answer' }
    ] }).find(e => e.kind === 'turn')
    const retained = replay(JSON.stringify(flagged))
    const absent = replay()
    if (!retained || retained.kind !== 'turn' || !absent || absent.kind !== 'turn') throw new Error('missing replay')
    const kept = retained.blocks.find(b => b.kind === 'tool')
    const lost = absent.blocks.find(b => b.kind === 'tool')
    expect(kept && foldOf(retained)?.hidden.has(kept.id)).not.toBe(true)
    expect(lost && foldOf(absent)?.hidden.has(lost.id)).toBe(true)
    expect(JSON.stringify(tree(entryNode(retained, 'main.replay', cx)))).toContain(notice)
    expect(JSON.stringify(tree(entryNode(absent, 'main.replay', cx)))).not.toContain(notice)
  })
})
