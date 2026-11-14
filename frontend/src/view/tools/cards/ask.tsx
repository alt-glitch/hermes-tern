// The clarify tool: omp's ask card. Settled, it folds to its head: the question and what the user
// answered (several questions: their count and each answer). Open, it shows each whole question
// and every choice offered, the picked ones checked. While the sheet asks, the card says it waits.

import type { JSX, SpanData } from '@stencil-hq/tern'

import type { ToolCall } from '../../../model.js'
import { type AskDetail, type AskQuestion, type AskResponse, splitQuestion } from '../../../tools/ask.js'
import { flat } from '../../format.js'
import { namedStep } from '../steps.js'
import type { Card, ToolView } from '../types.js'

/** The clarify tool's view. */
export const askView: ToolView<'clarify'> = { action: 'other', card: askCard, step: namedStep }

/** The question itself, on one line, for the head: as the sheet titles it. */
const asking = (q: AskQuestion | undefined) => flat(splitQuestion(q?.question ?? '').ask)

function askCard(call: ToolCall, d: AskDetail): Card {
  const qs = d.questions
  const several = qs.length > 1
  // Several questions each read in the body; the head counts them instead of repeating one.
  const asked = several ? `${qs.length} questions` : asking(qs[0]) || call.context
  const head = { name: 'ask', targetKind: 'text', title: 'Ask' } as const

  // While the sheet asks, the card only says so: the sheet shows the question and its choices.
  if (call.outcome.kind === 'running') {
    return { ...head, body: [<text key="waiting" role="hermes.ask.waiting" spans={[{ s: 'muted', t: 'Waiting for your answer' }]} />], target: asked }
  }

  const body: JSX.Element[] = []

  // Open, the card lists each question with what the user answered and every choice offered.
  for (const [i, q] of qs.entries()) {
    if (several || (q.question ?? '').trim().includes('\n')) {
      body.push(<md key={`q${i}`} role="hermes.ask.question">{q.question ?? ''}</md>)
    }

    const r = d.responses[i]
    const picked = new Set(r?.answers ?? [])

    for (const [j, c] of q.choices.entries()) {
      body.push(choiceRow(`q${i}.o${j}`, c, picked.has(c)))
    }

    // A typed answer, or why there is none, after the choices.
    for (const [j, typed] of (r?.answers ?? []).filter(a => !q.choices.includes(a)).entries()) {
      body.push(choiceRow(`q${i}.a${j}`, typed, true))
    }

    if (d.answered && r?.status !== 'answered') {
      body.push(
        <row align="start" gap="sm" key={`q${i}.none`} role="hermes.ask.verdict">
          <icon key="icon" name={d.outcome === 'timed_out' ? 'clock' : 'minus'} tone="muted" />
          <text key="t" spans={[{ s: 'muted', t: noAnswer(r, d) }]} wrap="word" />
        </row>
      )
    }
  }

  // Folded, the head says what was asked and what the user answered.
  return { ...head, body, folded: d.answered, target: [{ t: asked }, ...verdictSpans(d)] }
}

/**
 * The answers in a settled card's head, after its question: each question's answer, or why it has
 * none. A call with no result (history drops clarify's) has none: the answer is unknown, not missing.
 */
function verdictSpans(d: AskDetail): SpanData[] {
  if (!d.answered) {
    return []
  }

  const parts = d.questions.map((_, i): SpanData => {
    const r = d.responses[i]

    return r?.status === 'answered' ? { s: 'success', t: r.answers.join(', ') } : { s: 'muted', t: noAnswer(r, d) }
  })

  return [{ s: 'dim', t: '  →  ' }, ...parts.flatMap((p, i) => (i ? [{ s: 'dim', t: ' · ' }, p] : [p]))]
}

/** Why a question has no answer, in the user's terms. */
function noAnswer(r: AskResponse | undefined, d: AskDetail): string {
  if (r?.status === 'skipped' || d.outcome === 'cancelled') {
    return 'Skipped'
  }

  if (d.outcome === 'timed_out') {
    return 'No answer: the question timed out'
  }

  if (d.outcome === 'undelivered') {
    return 'No answer: no window showed the question'
  }

  return 'No answer'
}

/** One offered choice: checked when picked, a quiet dot when not. */
function choiceRow(key: string, text: string, picked: boolean): JSX.Element {
  return (
    <row align="start" gap="sm" key={key} role={picked ? 'hermes.ask.choice.on' : 'hermes.ask.choice'}>
      {picked ? <icon key="mark" name="check" tone="success" /> : <text key="mark" spans={[{ s: 'dim', t: '·' }]} />}
      <text key="t" spans={[picked ? { t: text } : { s: 'muted', t: text }]} wrap="word" />
    </row>
  )
}
