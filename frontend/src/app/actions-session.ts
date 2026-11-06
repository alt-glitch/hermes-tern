// Session and gateway-facing actions, shared by the app's stable action facade.

import type { ServerRequest } from '@hermes/shared/json-rpc-channel'

import { errorText } from '../core/errors.js'
import { storedCompactions } from '../hermes/compactions.js'
import { promptOverlay } from '../overlays/prompts.js'
import { parsePrompt } from '../prompts/parse.js'
import { interruptTurn } from '../turn/control.js'
import { type Prompt, shownText } from '../turn/prompt.js'
import type { GateState } from '../turn/router.js'
import { busyModeOf } from '../turn/serverQueue.js'
import { rpc } from '../wire/rpc.js'

import type { ActionsCx } from './actions.js'

export function gates(cx: ActionsCx): GateState {
  const { activity } = cx

  return {
    awaitingStartup: cx.attachments.awaitingStartup,
    busy: activity.busy !== null,
    canonical: cx.gw.isCanonical,
    compacting: activity.compacting !== undefined,
    sid: cx.state.ref.live,
    switching: cx.life.switching
  }
}

export function restore(cx: ActionsCx, prompt: Prompt) {
  const { composer } = cx
  const text = shownText(prompt)

  // The draft keeps its own pastes, and the prompt's come with it.
  composer.set(text && composer.text ? `${text}\n${composer.text}` : text || composer.text, {
    literal: composer.literal || prompt.kind !== 'typed',
    pasted: [...composer.pasted, ...(prompt.kind === 'typed' ? prompt.pasted : [])]
  })
  cx.attachments.restore(prompt.images)
}

export function interrupt(cx: ActionsCx) {
  const { activity } = cx
  const sid = cx.state.ref.live
  // The turn being stopped, by its row (a relabel keeps it; the next turn's row is another).
  const row = activity.busy?.since

  if (!sid) {
    return
  }

  // Last write wins: the stream's next label replaces this one.
  activity.relabel('Stopping…', { status: true })

  interruptTurn(cx.gw, sid).catch((error: unknown) => {
    const why = errorText(error)

    // A stale generation means the turn already ended: nothing to say.
    if (row && activity.busy?.since === row && !why.includes('stale_generation')) {
      // 'Working…', not the label it replaced: whatever the turn shows now.
      activity.relabel('Working…', { status: true })
      cx.transcript.notice(`Could not stop the turn: ${why}`, 'error')
      cx.changed()
    }
  })
  cx.changed()
}

export function setCompacting(cx: ActionsCx, on: boolean, { manual = false }: { manual?: boolean } = {}) {
  if (on) {
    cx.activity.startCompaction({ manual })
  } else {
    cx.activity.endCompaction()
    cx.queue.drain()
  }
}

export function summarize(cx: ActionsCx, delay = 0) {
  const { state, transcript } = cx
  const ticket = state.ticket()

  if (!transcript.compactions.unsummarized) {
    return
  }

  cx.timers.timeout(() => {
    const stored = state.info?.stored_session_id || state.ref.stored

    if (ticket.isCurrent() && stored && transcript.compactions.unsummarized) {
      transcript.compactions.summarize(storedCompactions(stored))
      cx.changed()
    }
  }, delay)
}

export async function readBusyMode(cx: ActionsCx) {
  const ticket = cx.state.ticket()

  if (!ticket.sid) {
    return
  }

  try {
    const r = await rpc(cx.gw, 'config.get', { key: 'busy', session_id: ticket.sid })

    if (ticket.isCurrent()) {
      cx.state.busyMode = busyModeOf(r?.value)
    }
  } catch {
    // Keeps `queue`.
  }
}

export async function attachStartupImage(cx: ActionsCx, sid: string) {
  await cx.attachments.attachStartup(sid)
  cx.queue.drain()
  cx.changed()
}

export function onRequest(cx: ActionsCx, req: ServerRequest) {
  // Held while a switch is in flight, or another session's prompt (it settles when that session closes).
  if (cx.life.route(req) !== 'show') {
    return
  }

  const prompt = parsePrompt(req)
  const overlay = prompt && promptOverlay(cx.chat, prompt)

  if (!prompt || !overlay) {
    req.fail(-32601, `${req.method} is not supported by the Tern frontend`)

    return
  }

  cx.sheets.open(overlay, prompt)
}
