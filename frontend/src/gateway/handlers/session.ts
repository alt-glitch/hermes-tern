// The gateway and the shown session: the gateway coming up or redialling, the session's info,
// usage and title, the session list changing, the view falling behind, and the goal and loop.

import { usageFromTick } from '@hermes/shared/usage-tick'

import type { Automation } from '../../automation.js'
import type { Reconnect } from '../../chrome/reconnect.js'
import type { Theme } from '../../chrome/theme.js'
import type { LiveSessionId } from '../../core/ids.js'
import type { PullRequests } from '../../github/store.js'
import type { SessionLifecycle } from '../../session/lifecycle.js'
import type { SessionState } from '../../session/state.js'
import type { SessionTitle } from '../../session/title.js'
import type { Transcript } from '../../transcript.js'
import { shownText, userImages } from '../../turn/prompt.js'
import type { PromptQueue } from '../../turn/queue.js'
import { pendingRows, usageCounters } from '../../wire/schemas.js'
import type { Handlers } from '../dispatch.js'

/** What the session's events reach of the app. */
export interface SessionCx {
  /** The shown session's runtime id: null before the first session and while the gateway is down. */
  sid(): LiveSessionId | null
  readonly session: Pick<SessionState, 'info' | 'usage'>
  readonly life: Pick<SessionLifecycle, 'fellBehind' | 'ready' | 'routeEvent'>
  readonly reconnect: Pick<Reconnect, 'ready' | 'redialing'>
  readonly theme: Pick<Theme, 'skin'>
  readonly automation: Pick<Automation, 'apply'>
  readonly title: Pick<SessionTitle, 'read' | 'set'>
  readonly queue: { readonly server: Pick<PromptQueue['server'], 'update'> }
  readonly transcript: Pick<Transcript, 'contextUsed' | 'started' | 'usageTick'>
  readonly prs: Pick<PullRequests, 'poke'>
  /** Tells Tern the session's folder (OSC 7), when it moved. */
  reportCwd(): void
}

/** The session's events. */
export const sessionHandlers = {
  'gateway.ready': (ev, cx) => {
    cx.reconnect.ready()
    cx.theme.skin(ev.payload?.skin)
    cx.life.ready()

    return 'render'
  },

  'gateway.reconnecting': (ev, cx) => {
    cx.reconnect.redialing(ev.payload?.attempt ?? 1, ev.payload?.delay_ms ?? 0)

    return 'render'
  },

  // The goal and loop line: every set, pause, resume, stop, wakeup and judged turn.
  'session.control.update': (ev, cx) => {
    cx.automation.apply(ev.session_id ?? cx.sid(), ev.payload?.control)

    return 'quiet'
  },

  'session.info': (ev, cx) => {
    const { session, transcript } = cx
    const cwd = session.info?.cwd
    // The shared owner's idle fanout carries only pending/revision/generation: merge, never replace.
    session.info = ev.payload ? { ...session.info, ...ev.payload } : session.info
    session.usage = ev.payload?.usage ?? session.usage
    transcript.contextUsed(session.usage?.context_used ?? 0)

    // A queued prompt the gateway started gets its bubble now, after the reply it waited for.
    for (const started of cx.queue.server.update(pendingRows(ev.payload))) {
      const own = started.own?.item.prompt
      transcript.started(own ? shownText(own) : started.text, undefined, own ? userImages(own.images) : [])
    }

    cx.title.set(typeof ev.payload?.title === 'string' ? ev.payload.title : undefined)

    // Another folder: another branch, maybe another PR.
    if (session.info?.cwd && session.info.cwd !== cwd) {
      cx.prs.poke()
      cx.reportCwd()
    }

    return 'render'
  },

  'session.usage': (ev, cx) => {
    const { session, transcript } = cx
    // The shared owner sends its counters at the top level; older gateways nest them.
    const tick = usageFromTick(ev.payload)
    session.usage = tick ? { ...session.usage, ...tick } : session.usage
    transcript.contextUsed(session.usage?.context_used ?? 0)
    const counters = usageCounters(ev.payload)

    if (counters) {
      transcript.usageTick(counters.counters, counters.tps)
    }

    return 'render'
  },

  'session.title': (ev, cx) => {
    cx.title.set(ev.payload?.title)

    return 'render'
  },

  // A title set by /title or Hermes' auto-titler reaches viewers only as a changed session list.
  'sessions.changed': (_ev, cx) => {
    cx.title.read()

    return 'quiet'
  },

  // The view fell behind: a fresh resume brings the snapshot and a new subscription.
  'session.replay_gap': (ev, cx) => {
    cx.life.fellBehind(ev.session_id)

    return 'quiet'
  }
} satisfies Handlers<SessionCx>
