// The gateway-backed commands' host (/steer, /queue, /stop, /tools, /undo, /compress, …): what
// control.ts and session.ts reach of the pane, made from its stores each time one of them runs.
// `sid` is the session it was made for (stale() says when the view left it); the
// rest, `busy` and `queued` among them, reads the stores live, so a command that awaited sees now.

import type { GatewayClient } from '@tui/gatewayClient.js'

import { durable, type StoredSessionId } from '../core/ids.js'
import type { Compaction } from '../model.js'
import type { SessionLifecycle } from '../session/lifecycle.js'
import type { SessionState } from '../session/state.js'
import type { Transcript } from '../transcript/store.js'
import type { Activity } from '../turn/activity.js'
import type { PromptQueue } from '../turn/queue.js'
import type { PromptRouter } from '../turn/router.js'

import type { SessionHost } from './session.js'

/** What the session host is made from. */
export interface SessionHostCx {
  readonly gw: GatewayClient
  readonly state: Pick<SessionState, 'ref' | 'ticket' | 'usage'>
  readonly activity: Pick<Activity, 'busy'>
  readonly queue: Pick<PromptQueue, 'count'>
  readonly router: Pick<PromptRouter, 'behind' | 'send'>
  readonly life: Pick<SessionLifecycle, 'reload' | 'resume'>
  readonly transcript: Pick<Transcript, 'compacted' | 'compacting' | 'notice' | 'panel' | 'steer' | 'uncompact'>
  changed(): void
  /** A compaction started (`manual`: /compress's) or ended. */
  setCompacting(on: boolean, opts: { manual: boolean }): void
  /** Submits `text` as the draft would, behind the turn whatever busy_input_mode says. */
  submit(text: string): void
}

/** The control and session commands' view of the shown session, made now. */
export function sessionHost(cx: SessionHostCx): SessionHost {
  const ticket = cx.state.ticket()
  const { sid } = ticket
  /** The compaction /compress opened: the one its 'none' takes back. */
  let started: Compaction | undefined

  return {
    get busy() {
      return cx.activity.busy !== null
    },
    // A steer that fell back to the queue: steering carries no images.
    canonical: cx.gw.isCanonical,
    enqueue: text => cx.router.behind({ images: [], kind: 'app', text }),
    gw: cx.gw,
    notice: (text, tone) => {
      cx.transcript.notice(text, tone)
      cx.changed()
    },
    // The shared gateway (the one /branch runs on) answers a resume with one id for both kinds.
    open: async (id: StoredSessionId) => {
      await cx.life.resume(id)

      return durable(cx.state.ref) === id
    },
    panel: (title, text) => {
      cx.transcript.panel(title, text)
      cx.changed()
    },
    compressing: state => {
      if (state === 'start') {
        started = cx.transcript.compacting({ before: cx.state.usage?.context_used || undefined, manual: true })
      } else if (state === 'none') {
        if (started) {
          cx.transcript.uncompact(started)
        }
      } else {
        cx.transcript.compacted(Date.now(), state)
      }

      cx.setCompacting(state === 'start', { manual: true })

      cx.changed()
    },
    get queued() {
      return cx.queue.count()
    },
    reload: async () => {
      if (sid && ticket.isCurrent()) {
        await cx.life.reload(sid)
      }
    },
    send: text => cx.router.send({ images: [], kind: 'app', text }),
    sid,
    stale: () => !ticket.isCurrent(),
    steered: text => {
      cx.transcript.steer(text)
      cx.changed()
    },
    // /queue: behind the turn whatever busy_input_mode says.
    submit: text => cx.submit(text)
  }
}
