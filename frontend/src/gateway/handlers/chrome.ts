// What the gateway says around the turn: its skin, keyed notices, plain notices and errors, a slow
// start, stray backend output, the self-improvement review, and /bg and /btw answers.

import { protocolNote, slowStartNotes } from '../../backendNotes.js'
import { isLoginNotice, type NoticeStrip } from '../../chrome/notices.js'
import type { Theme } from '../../chrome/theme.js'
import type { Transcript } from '../../transcript.js'
import type { EventOf, Handlers, Outcome } from '../dispatch.js'

/** The backend warnings shown already, so each stays one line; the app keeps it, and an adopt forgets `status`. */
export interface Warned {
  /** Stray backend output was reported once already. */
  protocol: boolean
  /** The status warning shown last, so a repeated one stays one line. */
  status: string | undefined
}

/** What the chrome's events reach of the app. */
export interface ChromeCx {
  readonly transcript: Pick<Transcript, 'notice' | 'panel'>
  readonly theme: Pick<Theme, 'skin'>
  readonly notices: Pick<NoticeStrip, 'clear' | 'show'>
  readonly warned: Warned
}

/** A /bg task's or a /btw question's answer, as a panel titled as Ink labels them. */
function answered(ev: EventOf<'background.complete' | 'btw.complete'>, cx: ChromeCx): Outcome {
  if (ev.payload && 'text' in ev.payload && typeof ev.payload.text === 'string' && ev.payload.text.trim()) {
    // Titled as Ink labels them: the task id /bg named, the question /btw asked.
    const question = 'question' in ev.payload && typeof ev.payload.question === 'string' ? ev.payload.question.trim() : ''
    const task = 'task_id' in ev.payload && typeof ev.payload.task_id === 'string' ? ` ${ev.payload.task_id}` : ''

    cx.transcript.panel(
      ev.type === 'btw.complete' ? `/btw${question ? ` ${question}` : ''}` : `Background task${task}`,
      ev.payload.text
    )
  }

  return 'render'
}

/** The chrome's events. */
export const chromeHandlers = {
  'skin.changed': (ev, cx) => {
    cx.theme.skin(ev.payload)

    return 'render'
  },

  'notification.show': (ev, cx) => {
    const p = ev.payload

    // A /login step (its link and code, then the result) is read and clicked, so it goes in the transcript.
    if (p && isLoginNotice(p)) {
      if (p.text?.trim()) {
        cx.transcript.panel('/login', p.text)
      }

      return 'render'
    }

    if (p) {
      cx.notices.show(p)
    }

    return 'render'
  },

  'notification.clear': (ev, cx) => {
    cx.notices.clear(ev.payload?.key)

    return 'render'
  },

  // What the background self-improvement review saved to memory or skills.
  'review.summary': (ev, cx) => {
    const text = String(ev.payload?.text ?? '').trim()

    if (!text) {
      return 'quiet'
    }

    cx.transcript.notice(text)

    return 'render'
  },

  notice: (ev, cx) => {
    cx.transcript.notice(ev.payload?.message ?? '')

    return 'render'
  },

  error: (ev, cx) => {
    cx.transcript.notice(ev.payload?.message ?? 'error', 'error')

    return 'render'
  },

  'gateway.start_timeout': (ev, cx) => {
    // The client keeps waiting for ready; the stderr lines say why it is slow (wrong python, a missing dependency).
    for (const note of slowStartNotes(ev.payload?.stderr_tail)) {
      cx.transcript.notice(note.text, note.tone)
    }

    return 'render'
  },

  'gateway.protocol_error': (ev, cx) => {
    const note = protocolNote(ev.payload?.preview, cx.warned.protocol)
    cx.warned.protocol = true

    if (!note) {
      return 'quiet'
    }

    cx.transcript.notice(note.text, note.tone)

    return 'render'
  },

  'background.complete': answered,
  'btw.complete': answered
} satisfies Handlers<ChromeCx>
