// The clarify sheet: one to five questions, each a single or multiple choice with an Other row,
// or a typed answer. Tabs move between the questions; each keeps its draft until the card is
// answered as a whole (`{answers}`), and an empty answer cancels every question at once.

import type { ClarifyResult } from '@hermes/shared/gateway-events'

import { Composer } from '../draft/composer.js'
import type { Overlay, OverlayHost } from '../overlays/overlay.js'
import { actionsRow } from '../view/ui/button.js'

import { answerWith, isCtrlC, moved, type Option, optionList, type Sending, sendingLine } from './ask.js'
import type { ClarifyPrompt, Question } from './parse.js'
import { promptKey } from './sheets.js'

/** Strips the backend's `(Recommended)` suffix from clarify's first choice. */
const RECOMMENDED = /\s*\(recommended\)\s*$/i

/** One question's answer state, kept while the user moves between questions. */
interface Draft {
  selected: number
  picked: Set<number>
  typing: boolean
  other: Composer
}

/** The first few words of a question, for its tab. */
function tabLabel(question: string): string {
  const words = question.replace(/[?.!:]+$/, '').split(/\s+/)

  return words.length > 4 ? `${words.slice(0, 4).join(' ')}…` : words.join(' ')
}

export function clarifyOverlay(host: OverlayHost, prompt: ClarifyPrompt): Overlay {
  const { questions, req } = prompt
  const answers = { ...prompt.answers }
  const drafts: Draft[] = questions.map(() => ({
    other: new Composer(),
    picked: new Set(),
    selected: 0,
    typing: false
  }))

  const key = promptKey(req.id)
  const sending: Sending = { busy: false, error: '' }
  const respond = (result: ClarifyResult) => answerWith(host, overlay, req, sending, { ...result })
  // After a refused answer, Esc closes the sheet unanswered: a retry may never land (a stale turn).
  const cancel = () => (sending.error ? host.close(overlay) : respond({}))

  let step = Math.max(
    0,
    questions.findIndex(q => !(q.qid in answers))
  )

  const optionsOf = (q: Question, d: Draft): Option[] => [
    ...q.choices.map((c, i): Option => ({
      checked: q.multi && d.picked.has(i),
      id: `option:${i}`,
      label: c.replace(RECOMMENDED, ''),
      recommended: RECOMMENDED.test(c),
      role: q.multi ? 'omp.ask.check' : 'omp.ask.option'
    })),
    { detail: d.other.text || 'Type your own answer', id: 'other', label: 'Other…', role: 'omp.ask.other' }
  ]

  /** Records the current question's answer and moves to the next unanswered one, or submits. */
  const commit = (answer: string | null) => {
    const q = questions[step]

    if (q) {
      answers[q.qid] = answer
    }

    const next = questions.findIndex((other, i) => i > step && !(other.qid in answers))
    const first = questions.findIndex(other => !(other.qid in answers))

    if (next >= 0 || first >= 0) {
      step = next >= 0 ? next : first
      host.changed()

      return
    }

    respond({ answers })
  }

  /** The answer the current question would get from Enter / Submit. */
  const submit = () => {
    const q = questions[step]
    const d = drafts[step]

    if (!q || !d) {
      return
    }

    const typed = d.other.text.trim()

    if (!q.choices.length) {
      return commit(typed || null)
    }

    if (!q.multi) {
      return commit(d.typing ? typed || null : (q.choices[d.selected]?.replace(RECOMMENDED, '') ?? null))
    }

    const picked = [...d.picked].sort((a, b) => a - b).map(i => q.choices[i]?.replace(RECOMMENDED, '') ?? '')

    // Nothing checked: Enter takes the highlighted row, as a single pick would.
    if (!picked.length && !typed && d.selected < q.choices.length) {
      picked.push(q.choices[d.selected]?.replace(RECOMMENDED, '') ?? '')
    }

    const values = typed ? [...picked, typed] : picked

    commit(values.length ? JSON.stringify(values) : null)
  }

  /** A click or Enter on row `i`: a radio answers, a checkbox toggles, Other starts typing. */
  const activate = (i: number) => {
    const q = questions[step]
    const d = drafts[step]

    if (!q || !d) {
      return
    }

    d.selected = i

    if (i >= q.choices.length) {
      d.typing = true
    } else if (q.multi && d.picked.has(i)) {
      d.picked.delete(i)
    } else if (q.multi) {
      d.picked.add(i)
    } else {
      d.typing = false

      return submit()
    }

    host.changed()
  }

  const go = (to: number) => {
    step = (to + questions.length) % questions.length
    host.changed()
  }

  const overlay: Overlay = {
    key,
    modal: true,
    // Every question at once: an empty answer is the contract's cancel ('' skips on the shared wire).
    cancel,
    focus: id => {
      const q = questions[step]
      const d = drafts[step]

      return q && d && (d.typing || !q.choices.length) ? `${id}.body.answer` : null
    },
    node: id => {
      const q = questions[step]
      const d = drafts[step]

      if (!q || !d) {
        return <overlay anchor="bottom" key={key} modal role="omp.overlay.ask" size="md" />
      }

      const freeText = !q.choices.length
      const last = questions.every((other, i) => i === step || other.qid in answers)

      return (
        <overlay anchor="bottom" key={key} modal role="omp.overlay.ask" size="md">
          <col gap="md" key="body">
            {questions.length > 1 ? (
              <row align="center" gap="sm" key="head" role="omp.ask.head">
                <tabs
                  active={String(step)}
                  items={questions.map((other, i) => ({
                    id: String(i),
                    label: `${other.qid in answers ? '✓ ' : ''}${tabLabel(other.question)}`
                  }))}
                  key="tabs"
                  onSelect={ev => {
                    const to = Number(ev.item)

                    if (Number.isInteger(to) && questions[to]) {
                      go(to)
                    }
                  }}
                  role="omp.ask.questions"
                />
                <spacer grow={1} key="fill" />
                <text key="count" spans={[{ s: 'dim', t: `${step + 1} of ${questions.length}` }]} wrap="none" />
              </row>
            ) : null}
            <md key="question" role="omp.ask.question" text={q.question} />
            {freeText
              ? null
              : optionList(
                  `q${step}`,
                  `${id}.body.q${step}`,
                  optionsOf(q, d),
                  d.selected,
                  i => {
                    d.selected = i
                    d.typing = i >= q.choices.length
                    host.changed()
                  },
                  activate
                )}
            {freeText || d.typing ? (
              <input
                cursor={d.other.cursor}
                key="answer"
                onEdit={ev => {
                  d.other.edit(ev)
                  host.changed()
                }}
                onUndo={() => {
                  d.other.undo()
                  host.changed()
                }}
                placeholder={freeText ? 'Type your answer' : 'Type your own answer'}
                role="omp.ask.input"
                text={d.other.text}
              />
            ) : null}
            {sendingLine(sending)}
            {actionsRow([
              { hint: 'escape', key: 'skip', keys: ['escape'], label: 'Skip', onClick: () => commit(null) },
              {
                hint: `enter${q.multi && !d.typing ? ' · space toggles' : ''} · up/down move${questions.length > 1 ? ' · tab switches question' : ''}`,
                key: 'submit',
                keys: ['enter'],
                kind: 'primary',
                label: last ? 'Submit' : 'Next',
                onClick: submit
              }
            ])}
          </col>
        </overlay>
      )
    },
    onKey: k => {
      const q = questions[step]
      const d = drafts[step]

      if (!q || !d) {
        return true
      }

      const typing = d.typing || !q.choices.length
      const count = q.choices.length + 1

      if (isCtrlC(k) || (k.name === 'escape' && sending.error)) {
        // The whole card, not just this question: an empty answer is cancel-all ('' on the shared wire).
        cancel()
      } else if (k.name === 'tab' && questions.length > 1) {
        go(step + (k.shift ? -1 : 1))
      } else if (k.name === 'escape' && typing && q.choices.length) {
        // Leave the Other field first; Esc on the list skips the question.
        d.typing = false
      } else if (k.name === 'escape') {
        commit(null)
      } else if (k.name === 'enter' && (typing || (q.multi && d.selected < q.choices.length))) {
        submit()
      } else if (k.name === 'enter') {
        activate(d.selected)
      } else if (typing) {
        const to = q.choices.length ? moved(k, d.selected, count) : undefined

        if (to !== undefined) {
          d.typing = false
          d.selected = to
        } else if (k.name !== 'up' && k.name !== 'down') {
          d.other.key(k)
        }
      } else {
        const to = moved(k, d.selected, count)
        const n = Number.parseInt(k.name, 10)

        if (to !== undefined) {
          d.selected = to
        } else if (k.name === 'space' && q.multi) {
          activate(d.selected)
        } else if (n >= 1 && n <= count) {
          activate(n - 1)
        } else if (k.text && !k.ctrl && !k.meta && k.name !== 'space') {
          // Typing on the list starts the Other answer.
          d.selected = q.choices.length
          d.typing = true
          d.other.key(k)
        }
      }

      return true
    }
  }

  return overlay
}
