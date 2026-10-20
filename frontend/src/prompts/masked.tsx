// The masked-value sheet: a sudo password, a secret, a password manager's master password, a
// one-time code (shown as typed) or a login to save (two fields). `''` answers "skipped".

import type { ValueResult } from '@hermes/shared/gateway-events'

import { Composer } from '../draft/composer.js'
import type { Overlay, OverlayHost } from '../overlays/overlay.js'
import { withoutTernEnv } from '../tools/terminal.js'
import { actionsRow } from '../view/ui/button.js'

import { answerWith, isCtrlC, type Sending, sendingLine } from './ask.js'
import { maskedOffset, maskOf, unmaskEdit } from './mask.js'
import type { MaskedPrompt } from './parse.js'
import { promptKey } from './sheets.js'

interface Field {
  id: string
  label: string
  masked: boolean
  value: Composer
}

export function maskedOverlay(host: OverlayHost, prompt: MaskedPrompt): Overlay {
  const { method, req, site } = prompt
  const key = promptKey(req.id)
  const login = method === 'vault.save_login'

  // A one-time code shows as typed, as the TUI's VaultCodePrompt does: a short code is easy to mistype.
  const code = method === 'vault.code'

  const fields: Field[] = login
    ? [
        { id: 'identifier', label: 'Username or email', masked: false, value: new Composer() },
        { id: 'password', label: 'Password', masked: true, value: new Composer() }
      ]
    : [{ id: 'value', label: code ? 'Type the code' : 'Hidden while you type', masked: !code, value: new Composer() }]

  let at = 0

  const title =
    method === 'sudo'
      ? 'Password for sudo'
      : method === 'secret'
        ? prompt.prompt || `Value for ${prompt.envVar || 'a secret'}`
        : method === 'vault.unlock_prompt'
          ? `Master password for ${prompt.manager || 'the password manager'}`
          : login
            ? `Save a login for ${site || 'this site'}`
            : `Code for ${site || 'this site'}`

  const note =
    method === 'secret'
      ? prompt.envVar
      : code
        ? [prompt.hint, 'typed into the page only · never shown to the model'].filter(Boolean).join(' · ')
        : ''

  const sending: Sending = { busy: false, error: '' }

  // `''` is the contract's "skipped / declined"; after a refused answer, cancel closes the sheet unanswered.
  const finish = (cancel: boolean) => {
    const [first, second] = fields

    if (cancel && sending.error) {
      return host.close(overlay)
    }

    answerWith(host, overlay, req, sending, {
      value: cancel
        ? ''
        : login
          ? JSON.stringify({ identifier: first?.value.text ?? '', password: second?.value.text ?? '' })
          : (first?.value.text ?? '')
    } satisfies ValueResult)
  }

  const overlay: Overlay = {
    key,
    modal: true,
    cancel: () => finish(true),
    focus: id => `${id}.body.${fields[at]?.id ?? 'value'}`,
    node: () => (
      <overlay anchor="bottom" key={key} modal role="omp.overlay.ask" size="md">
        <col gap="md" key="body">
          <md key="question" role="omp.ask.question" text={title} />
          {note ? (
            <text key="note" spans={[{ s: method === 'secret' ? 'mono dim' : 'muted', t: note }]} wrap="word" />
          ) : null}
          {prompt.command ? <code key="command" lang="bash" text={withoutTernEnv(prompt.command)} /> : null}
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
          {sendingLine(sending)}
          {actionsRow([
            { hint: 'escape', key: 'cancel', keys: ['escape'], label: 'Cancel', onClick: () => finish(true) },
            {
              hint: 'enter',
              key: 'ok',
              keys: ['enter'],
              kind: 'primary',
              label: login ? 'Save' : 'Submit',
              onClick: () => finish(false)
            }
          ])}
        </col>
      </overlay>
    ),
    onKey: k => {
      if (k.name === 'escape' || isCtrlC(k)) {
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
