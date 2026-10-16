// Questions the agent waits on (server requests): a dangerous-command
// approval, clarify's single/multi-choice or free-text questions, and masked
// values (sudo, secrets, vault prompts). Each is a modal bottom sheet in the
// shapes and roles omp's ask sheet uses (`omp.overlay.ask`, its options and
// action row), which Tern's chat styles size like the composer and read to
// show the pane as waiting for input.

import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import type { JSX, Key } from '@stencil-hq/tern'

import { Composer } from '../composer.js'
import { maskedOffset, maskOf, unmaskEdit } from '../mask.js'
import type { Overlay, OverlayHost } from '../overlay.js'

/** Strips the backend's `(Recommended)` suffix from clarify's first choice. */
const RECOMMENDED = /\s*\(recommended\)\s*$/i

interface Option {
  id: string
  label: string
  detail?: string
  recommended?: boolean
  checked?: boolean
  /** `omp.ask.option` (radio), `omp.ask.check` (checkbox) or `omp.ask.other`. */
  role?: string
}

interface Button {
  key: string
  label: string
  keys: string[]
  hint: string
  primary?: boolean
  onClick(): void
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function actionsRow(buttons: Button[]): JSX.Element {
  return (
    <row align="center" gap="sm" key="actions" role="omp.actions">
      <spacer grow={1} key="fill" />
      {buttons.map(b => (
        <row
          align="center"
          gap="xs"
          key={b.key}
          onClick={b.onClick}
          role="omp.btn"
          title={`${b.label}  ${b.hint}`}
          tone={b.primary ? 'accent' : undefined}
        >
          <text key="label" text={b.label} />
          <kbd key="keys" keys={b.keys} />
        </row>
      ))}
    </row>
  )
}

function optionList(
  listKey: string,
  id: string,
  options: Option[],
  selected: number,
  select: (i: number) => void,
  pick: (i: number) => void
): JSX.Element {
  const at = (item: string) => options.findIndex(o => `${id}.${o.id}` === item)

  return (
    <list
      key={listKey}
      onActivate={ev => {
        const i = at(ev.item)

        if (i >= 0) {
          pick(i)
        }
      }}
      onSelect={ev => {
        const i = at(ev.item)

        if (i >= 0) {
          select(i)
        }
      }}
      role="omp.ask.options"
      selected={options[selected] ? `${id}.${options[selected].id}` : undefined}
    >
      {options.map(o => (
        <item
          detail={o.detail ? [o.role === 'omp.ask.other' ? { s: 'dim', t: o.detail } : { t: o.detail }] : undefined}
          icon={o.checked ? 'check' : undefined}
          key={o.id}
          label={[{ t: o.label }]}
          role={o.role ?? 'omp.ask.option'}
          tone={o.checked ? 'success' : undefined}
          value={o.recommended ? [{ s: 'accent', t: 'Recommended' }] : undefined}
        />
      ))}
    </list>
  )
}

/** ↑/↓ (⌃P/⌃N) through `count` rows, wrapping; undefined when `key` isn't a move. */
function moved(key: Key, at: number, count: number): number | undefined {
  if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
    return (at - 1 + count) % count
  }

  if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
    return (at + 1) % count
  }

  return undefined
}

/** The overlay for a server request, or null for a method this frontend can't answer. */
export function promptOverlay(host: OverlayHost, req: ServerRequest): Overlay | null {
  switch (req.method) {
    case 'approval':
      return approvalOverlay(host, req)

    case 'clarify':
      if (!questionsOf(req.params.questions).length) {
        // Nothing to ask: answer at once (the first answer wins, so the caller's decline is a no-op).
        req.respond({})

        return null
      }

      return clarifyOverlay(host, req)

    case 'sudo':

    case 'secret':

    case 'vault.unlock_prompt':

    case 'vault.code':

    case 'vault.save_login':
      return maskedOverlay(host, req)

    default:
      return null
  }
}

// ── Approval ───────────────────────────────────────────────────────────

const APPROVALS: Option[] = [
  { detail: 'Run it this time only', id: 'once', label: 'Allow once' },
  { detail: 'Allow matching commands until the session ends', id: 'session', label: 'Allow for this session' },
  { detail: 'Remember this approval for every session', id: 'always', label: 'Always allow' },
  { detail: 'Tell the agent not to run it', id: 'deny', label: 'Deny' }
]

function approvalOverlay(host: OverlayHost, req: ServerRequest): Overlay {
  const p = req.params
  const command = str(p.command)
  const description = str(p.description)
  const smartDenied = p.smart_denied === true
  const offered = Array.isArray(p.choices) ? p.choices.filter(c => typeof c === 'string') : []

  // The TUI's rules: explicit choices win; a smart-guard deny leaves once/deny; no permanent scope drops "always".
  const allowed = new Set(
    offered.length
      ? offered
      : smartDenied
        ? ['once', 'deny']
        : p.allow_permanent === false
          ? ['once', 'session', 'deny']
          : ['once', 'session', 'always', 'deny']
  )

  if (p.allow_session === false) {
    allowed.delete('session')
  }

  const options = APPROVALS.filter(o => allowed.has(o.id))
  const key = `prompt:${req.id}`
  let selected = 0

  const answer = (choice: string) => {
    req.respond({ choice })
    host.close(overlay)
  }

  const overlay: Overlay = {
    key,
    modal: true,
    node: id => (
      <overlay anchor="bottom" key={key} modal role="omp.overlay.ask" size="md">
        <col gap="md" key="body">
          <md key="question" role="omp.ask.question" text="Allow this command?" />
          {command ? <code key="command" lang="bash" text={command} /> : null}
          {description || smartDenied ? (
            <row align="center" gap="xs" key="why">
              <icon key="icon" name="shield" tone={smartDenied ? 'error' : 'warning'} />
              <md
                key="text"
                text={`${smartDenied ? '**The safety check advised against it**' : '**Flagged**'}${description ? ` · ${description}` : ''}`}
              />
            </row>
          ) : null}
          {optionList(
            'options',
            `${id}.body.options`,
            options,
            selected,
            i => {
              selected = i
              host.changed()
            },
            i => answer(options[i]?.id ?? 'deny')
          )}
          {actionsRow([
            { hint: 'n · escape', key: 'deny', keys: ['escape'], label: 'Deny', onClick: () => answer('deny') },
            {
              hint: 'enter · y allows once · up/down move',
              key: 'choose',
              keys: ['enter'],
              label: 'Choose',
              onClick: () => answer(options[selected]?.id ?? 'deny'),
              primary: true
            }
          ])}
        </col>
      </overlay>
    ),
    onKey: k => {
      const n = Number.parseInt(k.name, 10)
      const to = moved(k, selected, options.length)

      if (to !== undefined) {
        selected = to
      } else if (n >= 1 && n <= options.length) {
        answer(options[n - 1]?.id ?? 'deny')
      } else if (k.name === 'enter') {
        answer(options[selected]?.id ?? 'deny')
      } else if (k.name === 'escape' || k.name === 'n') {
        answer('deny')
      } else if (k.name === 'y') {
        answer('once')
      }

      return true
    }
  }

  return overlay
}

// ── Clarify ────────────────────────────────────────────────────────────

interface Question {
  qid: string
  question: string
  choices: string[]
  multi: boolean
}

/** One question's answer state, kept while the user moves between questions. */
interface Draft {
  selected: number
  picked: Set<number>
  typing: boolean
  other: Composer
}

function questionsOf(raw: unknown): Question[] {
  if (!Array.isArray(raw)) {
    return []
  }

  return raw.flatMap((q: unknown): Question[] => {
    if (!q || typeof q !== 'object' || !('qid' in q) || !('question' in q)) {
      return []
    }

    const choices = 'choices' in q && Array.isArray(q.choices) ? q.choices.filter(c => typeof c === 'string') : []
    const question = str(q.question).trim()

    return question
      ? [{ choices, multi: 'multi_select' in q && q.multi_select === true, qid: str(q.qid), question }]
      : []
  })
}

/** The first few words of a question, for its tab. */
function tabLabel(question: string): string {
  const words = question.replace(/[?.!:]+$/, '').split(/\s+/)

  return words.length > 4 ? `${words.slice(0, 4).join(' ')}…` : words.join(' ')
}

function clarifyOverlay(host: OverlayHost, req: ServerRequest): Overlay {
  const questions = questionsOf(req.params.questions)
  const answers: Record<string, string | null> = {}
  const preset = req.params.answers

  if (preset && typeof preset === 'object') {
    for (const qid in preset) {
      const v: unknown = Reflect.get(preset, qid)

      if (typeof v === 'string' || v === null) {
        answers[qid] = v
      }
    }
  }

  const drafts: Draft[] = questions.map(() => ({
    other: new Composer(),
    picked: new Set(),
    selected: 0,
    typing: false
  }))

  const key = `prompt:${req.id}`

  let step = Math.max(
    0,
    questions.findIndex(q => !(q.qid in answers))
  )

  const optionsOf = (q: Question, d: Draft): Option[] => [
    ...q.choices.map((c, i) => ({
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

    req.respond({ answers })
    host.close(overlay)
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
            {actionsRow([
              { hint: 'escape', key: 'skip', keys: ['escape'], label: 'Skip', onClick: () => commit(null) },
              {
                hint: `enter${q.multi && !d.typing ? ' · space toggles' : ''} · up/down move${questions.length > 1 ? ' · tab switches question' : ''}`,
                key: 'submit',
                keys: ['enter'],
                label: last ? 'Submit' : 'Next',
                onClick: submit,
                primary: true
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

      if (k.name === 'tab' && questions.length > 1) {
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

// ── Masked values ──────────────────────────────────────────────────────

interface Field {
  id: string
  label: string
  masked: boolean
  value: Composer
}

function maskedOverlay(host: OverlayHost, req: ServerRequest): Overlay {
  const p = req.params
  const key = `prompt:${req.id}`
  const site = str(p.site) || str(p.origin)
  const login = req.method === 'vault.save_login'

  const fields: Field[] = login
    ? [
        { id: 'identifier', label: 'Username or email', masked: false, value: new Composer() },
        { id: 'password', label: 'Password', masked: true, value: new Composer() }
      ]
    : [{ id: 'value', label: 'Hidden while you type', masked: true, value: new Composer() }]

  let at = 0

  const title =
    req.method === 'sudo'
      ? 'Password for sudo'
      : req.method === 'secret'
        ? str(p.prompt) || `Value for ${str(p.env_var) || 'a secret'}`
        : req.method === 'vault.unlock_prompt'
          ? `Master password for ${str(p.display_name) || str(p.backend) || 'the password manager'}`
          : login
            ? `Save a login for ${site || 'this site'}`
            : `Code for ${site || 'this site'}`

  const note = req.method === 'secret' ? str(p.env_var) : req.method === 'vault.code' ? str(p.hint) : ''

  // `''` is the contract's "skipped / declined".
  const finish = (cancel: boolean) => {
    const [first, second] = fields
    req.respond({
      value: cancel
        ? ''
        : login
          ? JSON.stringify({ identifier: first?.value.text ?? '', password: second?.value.text ?? '' })
          : (first?.value.text ?? '')
    })
    host.close(overlay)
  }

  const overlay: Overlay = {
    key,
    modal: true,
    focus: id => `${id}.body.${fields[at]?.id ?? 'value'}`,
    node: () => (
      <overlay anchor="bottom" key={key} modal role="omp.overlay.ask" size="md">
        <col gap="md" key="body">
          <md key="question" role="omp.ask.question" text={title} />
          {note ? (
            <text key="note" spans={[{ s: req.method === 'secret' ? 'mono dim' : 'muted', t: note }]} wrap="word" />
          ) : null}
          {str(p.command) ? <code key="command" lang="bash" text={str(p.command)} /> : null}
          {fields.map((f, i) => (
            <input
              cursor={f.masked ? maskedOffset(f.value.text, f.value.cursor) : f.value.cursor}
              key={f.id}
              onEdit={ev => {
                at = i
                const edit = f.masked ? unmaskEdit(f.value.text, ev) : ev

                if (edit) {
                  f.value.edit(edit)
                }

                host.changed()
              }}
              onFocus={() => {
                // A click in the other field: the keys follow the caret there.
                at = i
                host.changed()
              }}
              placeholder={f.label}
              role="omp.ask.input"
              text={f.masked ? maskOf(f.value.text) : f.value.text}
            />
          ))}
          {actionsRow([
            { hint: 'escape', key: 'cancel', keys: ['escape'], label: 'Cancel', onClick: () => finish(true) },
            {
              hint: 'enter',
              key: 'ok',
              keys: ['enter'],
              label: login ? 'Save' : 'Submit',
              onClick: () => finish(false),
              primary: true
            }
          ])}
        </col>
      </overlay>
    ),
    onKey: k => {
      if (k.name === 'escape') {
        finish(true)
      } else if (k.name === 'tab' && fields.length > 1) {
        at = (at + 1) % fields.length
      } else if (k.name === 'enter' && at < fields.length - 1) {
        at += 1
      } else if (k.name === 'enter') {
        finish(false)
      } else if (k.name !== 'up' && k.name !== 'down') {
        fields[at]?.value.key(k)
      }

      return true
    }
  }

  return overlay
}

// ── Confirm ────────────────────────────────────────────────────────────

/** A yes/no sheet for a choice the frontend itself must confirm (an expensive model switch). */
export function confirmOverlay(
  host: OverlayHost,
  ask: { title: string; detail: string; confirm: string; onConfirm(): void }
): Overlay {
  const key = `confirm:${ask.title}`

  const answer = (yes: boolean) => {
    host.close(overlay)

    if (yes) {
      ask.onConfirm()
    }
  }

  const overlay: Overlay = {
    key,
    modal: true,
    node: () => (
      <overlay anchor="bottom" key={key} modal role="omp.overlay.ask" size="md">
        <col gap="md" key="body">
          <md key="question" role="omp.ask.question" text={ask.title} />
          {ask.detail ? <text key="detail" text={ask.detail} wrap="word" /> : null}
          {actionsRow([
            { hint: 'n · escape', key: 'cancel', keys: ['escape'], label: 'Cancel', onClick: () => answer(false) },
            {
              hint: 'enter · y',
              key: 'ok',
              keys: ['enter'],
              label: ask.confirm,
              onClick: () => answer(true),
              primary: true
            }
          ])}
        </col>
      </overlay>
    ),
    onKey: k => {
      if (k.name === 'enter' || k.name === 'y') {
        answer(true)
      } else if (k.name === 'escape' || k.name === 'n') {
        answer(false)
      }

      return true
    }
  }

  return overlay
}
