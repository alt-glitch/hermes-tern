// The approval sheet: a dangerous command waits on the user's decision. The command and why it
// was flagged, then the answers the request offers (once, for the session, always, deny).

import type { ApprovalChoice, ApprovalResult } from '@hermes/shared/gateway-events'

import type { Overlay, OverlayHost } from '../overlay.js'
import { withoutTernEnv } from '../view/describe.js'
import { actionsRow } from '../view/ui/button.js'

import { answerWith, isCtrlC, moved, type Option, optionList, type Sending, sendingLine } from './ask.js'
import type { ApprovalPrompt } from './parse.js'
import { promptKey } from './sheets.js'

const APPROVALS: Record<ApprovalChoice, Omit<Option, 'id'>> = {
  always: { detail: 'Remember this approval for every session', label: 'Always allow' },
  deny: { detail: 'Tell the agent not to run it', label: 'Deny' },
  once: { detail: 'Run it this time only', label: 'Allow once' },
  session: { detail: 'Allow matching commands until the session ends', label: 'Allow for this session' }
}

export function approvalOverlay(host: OverlayHost, prompt: ApprovalPrompt): Overlay {
  const { description, req, smartDenied } = prompt
  const command = prompt.command && withoutTernEnv(prompt.command)
  const options = prompt.choices.map(id => ({ id, ...APPROVALS[id] }))
  const key = promptKey(req.id)
  const sending: Sending = { busy: false, error: '' }
  let selected = 0

  const answer = (choice: ApprovalChoice) => answerWith(host, overlay, req, sending, { choice } satisfies ApprovalResult)
  const chosen = (i: number) => answer(options[i]?.id ?? 'deny')
  // After a refused answer, Esc closes the sheet unanswered: a retry may never land (a stale turn).
  const decline = () => (sending.error ? host.close(overlay) : answer('deny'))

  const overlay: Overlay = {
    key,
    modal: true,
    cancel: decline,
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
            chosen
          )}
          {sendingLine(sending)}
          {actionsRow([
            { hint: 'n · escape', key: 'deny', keys: ['escape'], label: 'Deny', onClick: () => answer('deny') },
            {
              hint: 'enter · y allows once · up/down move',
              key: 'choose',
              keys: ['enter'],
              kind: 'primary',
              label: 'Choose',
              onClick: () => chosen(selected)
            }
          ])}
        </col>
      </overlay>
    ),
    onKey: k => {
      const n = Number.parseInt(k.name, 10)
      const to = moved(k, selected, options.length)

      if (isCtrlC(k) || k.name === 'escape') {
        decline()
      } else if (to !== undefined) {
        selected = to
      } else if (n >= 1 && n <= options.length) {
        chosen(n - 1)
      } else if (k.name === 'enter') {
        chosen(selected)
      } else if (k.name === 'n') {
        answer('deny')
      } else if (k.name === 'y') {
        answer('once')
      }

      return true
    }
  }

  return overlay
}
