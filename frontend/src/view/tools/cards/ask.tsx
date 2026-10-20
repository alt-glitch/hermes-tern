// The clarify tool: omp's ask card, each question with its choices and the answers picked.

import type { JSX } from '@stencil-hq/tern'

import type { ToolCall } from '../../../model.js'
import type { AskDetail } from '../../../tools/ask.js'
import { namedStep } from '../steps.js'
import type { Card, ToolView } from '../types.js'

/** The clarify tool's view. */
export const askView: ToolView<'clarify'> = { action: 'other', card: askCard, step: namedStep }

/** The questions asked, their choices (the picked ones checked) and any typed answer. */
function askCard(call: ToolCall, d: AskDetail): Card {
  const qs = d.questions
  const body: JSX.Element[] = []

  for (const [i, q] of qs.entries()) {
    const choices = q.choices
    const answers = d.responses[i]?.answers ?? []

    // One question already reads in the head; several each get their own.
    if (qs.length > 1) {
      body.push(<md key={`q${i}`}>{q.question ?? ''}</md>)
    }

    for (const [j, c] of choices.entries()) {
      body.push(answerRow(`q${i}.o${j}`, c, answers.includes(c)))
    }

    for (const [j, typed] of answers.filter(a => !choices.includes(a)).entries()) {
      body.push(answerRow(`q${i}.a${j}`, typed, true))
    }

    // History drops clarify's result: with none, the answer is unknown, not missing.
    if (!answers.length && call.status !== 'running' && d.answered) {
      const skipped = d.responses[i]?.skipped === true
      body.push(<text key={`q${i}.none`} role="omp.tool.notice" spans={[{ s: 'muted', t: skipped ? 'Skipped' : 'No answer' }]} />)
    }
  }

  return {
    body,
    name: 'ask',
    // Several questions each read in the body; the head counts them instead of repeating one.
    target: qs.length > 1 ? `${qs.length} questions` : (qs[0]?.question ?? call.context),
    targetKind: 'text',
    title: 'Ask'
  }
}

function answerRow(key: string, text: string, picked: boolean): JSX.Element {
  return (
    <row key={key} role={picked ? 'omp.tool.answer' : 'omp.tool.answer.off'}>
      <text key="c" spans={[picked ? { s: 'success', t: '✓' } : { s: 'dim', t: '·' }]} />
      <text key="t" spans={[{ t: text }]} />
    </row>
  )
}
