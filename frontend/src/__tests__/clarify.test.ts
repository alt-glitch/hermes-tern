// The clarify tool end to end in this frontend: its sheet (the question, its context, the keys it
// takes, its place among a shared call's cards) and its transcript card (folded to the question
// and the answer, kept out of the turn's "Worked for" fold, and the working line while it waits).
import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import { promptHandlers, type PromptsCx } from '../gateway/handlers/prompts.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import type { OverlayHost } from '../overlays/overlay.js'
import { promptOverlay } from '../overlays/prompts.js'
import { parsePrompt } from '../prompts/parse.js'
import { askDetail, splitQuestion } from '../tools/ask.js'
import { toolNode } from '../view/tools/shell.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { busyLabel, foldOf } from '../view/workLogModel.js'

import { key, must, spanTexts, stub, tree } from './fakes.js'

const call = (args: Record<string, unknown>, more: Partial<ToolCall> = {}): ToolCall => ({
  args,
  argsText: '',
  context: '',
  id: toolCallId('c1'),
  name: 'clarify',
  outcome: { duration: 4_000, kind: 'done' },
  startedAt: 0,
  via: { kind: 'direct' },
  ...more
})

const colour = { questions: [{ choices: ['red', 'green', 'blue'], question: 'Which colour?' }] }

/** Every text a node tree shows: its spans, texts, target spans and labels, in order. */
function texts(n: NodeJson): string[] {
  const own = ['text', 'spans', 'target', 'label'].flatMap(k => {
    const v = n.p?.[k]

    return typeof v === 'string' ? [v] : spanTexts(v)
  })

  return [...own, ...(n.c ?? []).flatMap(texts)]
}

/** The clarify sheet for `params`, with what it answered and closed. */
function sheet(params: Record<string, unknown>) {
  const answers: Record<string, unknown>[] = []
  const host: OverlayHost = { changed: () => undefined, close: () => undefined, open: () => undefined }
  const req: ServerRequest = { fail: () => undefined, id: 'r1', method: 'clarify', params, respond: r => void answers.push(r) }
  const overlay = must(promptOverlay(host, must(parsePrompt(req))))

  return { answers, overlay, shown: () => tree(overlay.node('layer.prompt:r1')) }
}

/** The first node under `n` whose role is `role`. */
function byRole(n: NodeJson, role: string): NodeJson | undefined {
  return n.p?.['role'] === role ? n : (n.c ?? []).map(c => byRole(c, role)).find(Boolean)
}

describe('the clarify sheet', () => {
  it('titles a long question by its closing line and keeps the rest as context under it', () => {
    expect(splitQuestion('Two ways to do it:\n\n1. Fast\n2. Safe\n\nWhich one?')).toEqual({ ask: 'Which one?', context: 'Two ways to do it:\n\n1. Fast\n2. Safe' })
    // A closing list is not a question: the opening line heads it.
    expect(splitQuestion('Which one?\n\n1. Fast\n2. Safe')).toEqual({ ask: 'Which one?', context: '1. Fast\n2. Safe' })
    expect(splitQuestion('Just this?')).toEqual({ ask: 'Just this?', context: '' })

    const { shown } = sheet({ questions: [{ choices: ['a'], qid: 'q0', question: 'Context first.\n\nWhich one?' }] })
    expect(byRole(shown(), 'omp.ask.question')?.p?.['text']).toBe('Which one?')
    expect(byRole(shown(), 'hermes.ask.context')?.p?.['text']).toBe('Context first.')
  })

  it('numbers every option and names the keys it takes, which change while typing', () => {
    const { overlay, shown } = sheet({ questions: [{ choices: ['red (Recommended)', 'green'], qid: 'q0', question: 'Which?' }] })
    const options = must(byRole(shown(), 'omp.ask.options'))

    expect((options.c ?? []).map(o => [o.p?.['label'], o.p?.['hint']])).toEqual([
      [[{ t: 'red' }], ['1']],
      [[{ t: 'green' }], ['2']],
      [[{ t: 'Other…' }], ['3']]
    ])
    expect(texts(must(byRole(shown(), 'hermes.ask.keys')))).toEqual(['move', 'pick', 'choose', 'skip'])

    overlay.onKey(key('3'))
    expect(texts(must(byRole(shown(), 'hermes.ask.keys')))).toEqual(['submit', 'back to the choices'])
  })

  it('draws a multiple choice with checkboxes, Other among them, and says space toggles', () => {
    const { overlay, shown } = sheet({ questions: [{ choices: ['a', 'b'], multi_select: true, qid: 'q0', question: 'Which?' }] })

    overlay.onKey(key('space'))
    const rows = must(byRole(shown(), 'omp.ask.options')).c ?? []
    expect(rows.map(r => [r.p?.['role'], r.p?.['icon'] ?? null])).toEqual([
      ['omp.ask.check', 'check'],
      ['omp.ask.check', null],
      ['omp.ask.other.check', null]
    ])
    expect(texts(must(byRole(shown(), 'hermes.ask.keys')))).toEqual(['move', '/', 'toggle', 'submit', 'skip'])
  })

  it("shows the shared call's place and says Next until its last card", () => {
    const at = (index: number) =>
      texts(sheet({ place: { index, total: 3 }, questions: [{ choices: ['a'], qid: 'p1', question: 'Which?' }] }).shown())

    expect(at(0)).toEqual(expect.arrayContaining(['Question 1 of 3', 'Next']))
    expect(at(2)).toEqual(expect.arrayContaining(['Question 3 of 3', 'Submit']))
    // A place that does not fit is dropped, not shown.
    expect(texts(sheet({ place: { index: 3, total: 3 }, questions: [{ qid: 'p1', question: 'Which?' }] }).shown()).join(' ')).not.toMatch(/of 3/)
  })
})

describe('a shared clarify card finds its place in the running call', () => {
  function asked(running: ToolCall | undefined, question: string) {
    const requests: ServerRequest[] = []
    const cx: PromptsCx = {
      changed: () => undefined,
      gw: stub({ request: vi.fn() }),
      life: { unhold: () => false },
      request: req => void requests.push(req),
      sheets: { drop: () => undefined, dropByApproval: () => undefined, shows: () => false },
      transcript: { lastCall: match => (running && match(running) ? running : undefined), notice: () => undefined }
    }

    promptHandlers['clarify.request']({ payload: { execution_generation: 1, prompt_id: 'p1', question }, session_id: 's1', type: 'clarify.request' }, cx)

    const prompt = parsePrompt(must(requests[0]))

    return prompt?.kind === 'clarify' ? prompt.place : 'not clarify'
  }

  const three = { questions: [{ question: 'One?' }, { question: 'Two?' }, { question: 'Three?' }] }

  it('by its question among the call’s questions', () => {
    expect(asked(call(three, { outcome: { kind: 'running' } }), 'Two?')).toEqual({ index: 1, total: 3 })
  })

  it('and has none for a one-question call, a question the call does not ask, or no running call', () => {
    expect(asked(call(colour, { outcome: { kind: 'running' } }), 'Which colour?')).toBeUndefined()
    expect(asked(call(three, { outcome: { kind: 'running' } }), 'Four?')).toBeUndefined()
    expect(asked(call(three), 'Two?')).toBeUndefined()
  })
})

describe('the clarify card', () => {
  const head = (n: NodeJson) => spanTexts(n.p?.['target']).join('')

  it('only says it waits while the sheet asks', () => {
    const n = tree(toolNode(call(colour, { outcome: { kind: 'running' } }), 0))

    expect([n.p?.['target'], n.p?.['collapsed']]).toEqual(['Which colour?', undefined])
    expect(texts(n)).toEqual(['Which colour?', 'Waiting for your answer'])
  })

  it('folds to the question and the answer, and opens to every choice with the pick checked', () => {
    const result = { outcome: 'submitted', responses: [{ status: 'answered', user_response: 'green' }] }
    const n = tree(toolNode(call(colour, { result }), 0))

    expect([head(n), n.p?.['collapsed']]).toEqual(['Which colour?  →  green', true])
    expect(n.p?.['target']).toEqual(expect.arrayContaining([{ s: 'success', t: 'green' }]))
    expect((n.c ?? []).map(r => [r.p?.['role'], texts(r).at(-1)])).toEqual([
      ['hermes.ask.choice', 'red'],
      ['hermes.ask.choice.on', 'green'],
      ['hermes.ask.choice', 'blue']
    ])
  })

  it('heads several questions by their count and every answer, a typed one and a skip among them', () => {
    const args = { questions: [{ choices: ['main', 'dev'], question: 'Branch?' }, { question: 'Notes?' }, { question: 'Title?' }] }
    const result = {
      outcome: 'submitted',
      responses: [
        { status: 'answered', user_response: 'dev' },
        { status: 'answered', user_response: 'Mention the screenshots' },
        { status: 'skipped', user_response: null }
      ]
    }
    const n = tree(toolNode(call(args, { result }), 0))

    expect(head(n)).toBe('3 questions  →  dev · Mention the screenshots · Skipped')
    expect(texts(n)).toEqual(expect.arrayContaining(['Branch?', 'Notes?', 'Mention the screenshots', 'Title?', 'Skipped']))
  })

  it('says a question timed out, or went to no window, rather than leaving it blank', () => {
    const unanswered = { responses: [{ status: 'unanswered', user_response: null }] }

    expect(head(tree(toolNode(call(colour, { result: { ...unanswered, outcome: 'timed_out' } }), 0)))).toBe('Which colour?  →  No answer: the question timed out')
    expect(head(tree(toolNode(call(colour, { result: { ...unanswered, outcome: 'undelivered' } }), 0)))).toMatch(/no window showed/)
    expect(head(tree(toolNode(call(colour, { result: { ...unanswered, outcome: 'cancelled' } }), 0)))).toMatch(/Skipped$/)
  })

  it("keeps a resumed call's answer unknown: history drops clarify's result", () => {
    const n = tree(toolNode(call(colour), 0))

    expect([head(n), n.p?.['collapsed']]).toEqual(['Which colour?', false])
  })

  it('reads a multi-select answer and an outcome it does not know', () => {
    const d = askDetail({ args: { questions: [{ choices: ['a', 'b'], multi_select: true, question: 'Q?' }] }, result: { outcome: 'odd', responses: [{ user_response: ['a', ''] }] } })

    expect(d).toMatchObject({ outcome: undefined, questions: [{ multi: true }], responses: [{ answers: ['a'], status: 'answered' }] })
  })
})

describe('a clarify call in its turn', () => {
  const block = (c: ToolCall): Block => ({ call: c, id: entryId('b1'), kind: 'tool' })

  it('stays out of the "Worked for" fold once the turn ends: the answer is the user’s own words', () => {
    const blocks: Block[] = [
      block(call(colour, { result: { responses: [{ status: 'answered', user_response: 'red' }] } })),
      { id: entryId('b2'), kind: 'text', text: 'Red it is.' }
    ]
    const turn: TurnEntry = { blocks, end: { endedAt: 9, status: 'done' }, id: entryId('t'), kind: 'turn', rev: 0, startedAt: 0 }

    expect(foldOf(turn)).toBeUndefined()
  })

  it('says the agent waits on the user, not that it thinks, while the sheet is open', () => {
    const running = call(colour, { outcome: { kind: 'running' } })
    const turn: TurnEntry = { blocks: [block(running)], end: { status: 'live' }, id: entryId('t'), kind: 'turn', rev: 0, startedAt: 0 }
    const cx: TranscriptContext = { copy: () => undefined, now: 9, welcome: { tip: '', version: '' } }

    expect(JSON.stringify(tree(entryNode(turn, 'main.t', cx)))).not.toContain('Thinking')
    expect(busyLabel(running)).toBe('Waiting for your answer…')
  })
})
