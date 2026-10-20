// The clarify tool: omp's ask card, each question with its choices and the answers picked.

import type { JSX } from '@stencil-hq/tern'

import type { ToolCall } from '../../../model.js'
import { record } from '../../../wire/json.js'
import { nonEmpty } from '../../format.js'
import type { Card } from '../types.js'

/** The questions asked, their choices (the picked ones checked) and any typed answer. */
export function askCard(call: ToolCall, result: Record<string, unknown> | undefined): Card {
  const qs = (Array.isArray(call.args.questions) ? call.args.questions : nonEmpty(call.args.question) ? [call.args] : [])
    .map(q => record(q))
    .filter(q => q !== undefined)

  const responses = Array.isArray(result?.responses) ? result.responses.map(r => record(r)) : []
  const body: JSX.Element[] = []

  for (const [i, q] of qs.entries()) {
    const choices = Array.isArray(q.choices) ? q.choices.map(c => nonEmpty(c)).filter(c => c !== undefined) : []
    // A multi-select answer is a list of picks; a single answer a string.
    const raw = responses[i]?.user_response
    const answers = (Array.isArray(raw) ? raw : [raw]).map(a => nonEmpty(a)).filter(a => a !== undefined)

    // One question already reads in the head; several each get their own.
    if (qs.length > 1) {
      body.push(<md key={`q${i}`}>{nonEmpty(q.question) ?? ''}</md>)
    }

    for (const [j, c] of choices.entries()) {
      body.push(answerRow(`q${i}.o${j}`, c, answers.includes(c)))
    }

    for (const [j, typed] of answers.filter(a => !choices.includes(a)).entries()) {
      body.push(answerRow(`q${i}.a${j}`, typed, true))
    }

    // History drops clarify's result: with none, the answer is unknown, not missing.
    if (!answers.length && call.status !== 'running' && result !== undefined) {
      const skipped = responses[i]?.status === 'skipped'
      body.push(<text key={`q${i}.none`} role="omp.tool.notice" spans={[{ s: 'muted', t: skipped ? 'Skipped' : 'No answer' }]} />)
    }
  }

  return {
    body,
    name: 'ask',
    // Several questions each read in the body; the head counts them instead of repeating one.
    target: qs.length > 1 ? `${qs.length} questions` : (nonEmpty(qs[0]?.question) ?? call.context),
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
