// Questions the agent waits on (server requests): a dangerous-command approval, clarify's
// single/multi-choice or free-text questions, and masked values (sudo, secrets, vault prompts).
// prompts/parse.ts reads the request once; each kind has its sheet in prompts/ (approval.tsx,
// clarify.tsx, masked.tsx), keyed by its request id (prompts/sheets.ts). The yes/no sheet for a
// choice the frontend itself confirms lives here too.

import type { Overlay, OverlayHost } from '../overlay.js'
import { approvalOverlay } from '../prompts/approval.js'
import { settleQuietly } from '../prompts/ask.js'
import { clarifyOverlay } from '../prompts/clarify.js'
import { maskedOverlay } from '../prompts/masked.js'
import type { PromptRequest } from '../prompts/parse.js'
import { actionsRow } from '../view/ui/button.js'

/** What the TUI says when an unanswered password, secret or vault card times out (and desktop, for a legacy approval). */
const TIMEOUT_NOTICES: Record<string, string> = {
  approval:
    'Approval timed out: the command was not run. Ask Hermes to try again when you are ready to answer.',
  secret:
    'Secret prompt closed: no answer in time, so the step that needed it was skipped. Send your request again when you are ready to enter it.',
  sudo: 'Password prompt closed: no answer in time, so the command was skipped. Send your request again when you are ready to enter it.',
  'vault.code':
    'Verification-code prompt closed: no answer in time, so the sign-in was skipped. Send your request again when you have the code.',
  'vault.save_login':
    'Save-login prompt closed: no answer in time, so nothing was saved. Send your request again when you are ready.',
  'vault.unlock_prompt':
    'Unlock prompt closed: no answer in time, so the password manager stayed locked. Send your request again when you are ready to unlock it.'
}

/** The transcript line for a `request.cancel`, or null (not a timeout; clarify records its own via tool.complete). */
export function promptTimeoutNotice(method: unknown, reason: unknown): string | null {
  return reason === 'timeout' && typeof method === 'string' ? (TIMEOUT_NOTICES[method] ?? null) : null
}

/** The sheet for `prompt`, or null when there is nothing to ask. */
export function promptOverlay(host: OverlayHost, prompt: PromptRequest): Overlay | null {
  switch (prompt.kind) {
    case 'approval':
      return approvalOverlay(host, prompt)

    case 'clarify':
      if (!prompt.questions.length) {
        // Nothing to ask: answer at once (the first answer wins, so the caller's decline is a no-op).
        settleQuietly(prompt.req.respond({}))

        return null
      }

      return clarifyOverlay(host, prompt)

    case 'masked':
      return maskedOverlay(host, prompt)
  }
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
    cancel: () => answer(false),
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
              kind: 'primary',
              label: ask.confirm,
              onClick: () => answer(true)
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
