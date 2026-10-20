// The approval sheet: a dangerous command waits on the user's decision. The command and why it
// was flagged, then one button per answer the request offers (deny, always, session, once).

import type { ApprovalChoice, ApprovalResult } from '@hermes/shared/gateway-events'

import type { Overlay, OverlayHost } from '../overlays/overlay.js'
import { withoutTernEnv } from '../view/describe.js'
import { actionsRow } from '../view/ui/button.js'

import { answerWith, isCtrlC, type Option, type Sending, sendingLine } from './ask.js'
import type { ApprovalPrompt } from './parse.js'
import { promptKey } from './sheets.js'

/** The approval's answers, one button each, in the order the action row shows them (Enter's last). */
const APPROVALS = [
  { detail: 'Tell the agent not to run it', id: 'deny', keys: ['escape'], label: 'Deny', typed: 'n' },
  { detail: 'Remember this approval for every session', id: 'always', keys: ['a'], label: 'Always allow', typed: 'a' },
  {
    detail: 'Allow matching commands until the session ends',
    id: 'session',
    keys: ['s'],
    label: 'Allow for this session',
    typed: 's'
  },
  { detail: 'Run it this time only', id: 'once', keys: ['enter'], label: 'Allow once', typed: 'y' }
] as const satisfies readonly (Omit<Option, 'id'> & { id: ApprovalChoice; keys: readonly string[]; typed: string })[]

export function approvalOverlay(host: OverlayHost, prompt: ApprovalPrompt): Overlay {
  const { description, req, smartDenied } = prompt
  const command = prompt.command && withoutTernEnv(prompt.command)
  const choices = APPROVALS.filter(c => prompt.choices.includes(c.id))
  const key = promptKey(req.id)
  const sending: Sending = { busy: false, error: '' }

  const answer = (choice: ApprovalChoice) => answerWith(host, overlay, req, sending, { choice } satisfies ApprovalResult)
  // After a refused answer, Esc closes the sheet unanswered: a retry may never land (a stale turn).
  const decline = () => (sending.error ? host.close(overlay) : answer('deny'))

  const overlay: Overlay = {
    key,
    modal: true,
    cancel: decline,
    node: () => (
      <overlay anchor="bottom" key={key} modal role="omp.overlay.ask" size="md">
        <col gap="md" key="body">
          <md key="question" role="omp.ask.question" text="Allow this command?" />
          {description || smartDenied ? (
            <row align="start" gap="xs" key="why">
              <icon key="icon" name="shield" tone={smartDenied ? 'error' : 'warning'} />
              <md
                key="text"
                text={`${smartDenied ? '**The safety check advised against it**' : '**Flagged**'}${description ? ` · ${description}` : ''}`}
              />
            </row>
          ) : null}
          {command ? <code key="command" lang="bash" max={{ h: '12lines' }} text={command} wrap /> : null}
          {sendingLine(sending)}
          {actionsRow(
            choices.map(c => ({
              hint: `${c.detail} · ${c.id === 'deny' ? 'escape, n' : c.id === 'once' ? 'enter, y' : c.typed}`,
              key: c.id,
              keys: [...c.keys],
              label: c.label,
              onClick: () => answer(c.id),
              ...(c.id === 'once' ? { kind: 'primary' as const } : {})
            }))
          )}
        </col>
      </overlay>
    ),
    onKey: k => {
      if (isCtrlC(k) || k.name === 'escape') {
        decline()
      } else if (k.name === 'enter') {
        answer(choices.some(c => c.id === 'once') ? 'once' : 'deny')
      } else if (!k.ctrl && !k.meta && !k.alt) {
        const typed = choices.find(c => c.typed === k.name)

        if (typed) {
          answer(typed.id)
        }
      }

      return true
    }
  }

  return overlay
}
