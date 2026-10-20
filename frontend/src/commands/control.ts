// Turn controls routed to the shared gateway's dedicated RPCs (session.steer,
// session.interrupt, process.stop, tools.show, prompt.background, prompt.btw) instead of
// `slash.exec`. Mirrors Hermes' ui-tui/src/app/slash/commands/core.ts (/steer, /queue, /stop,
// /tools) and session.ts (/bg, /btw).
import type { GatewayClient } from '@tui/gatewayClient.js'

import { errorText } from '../core/errors.js'
import type { LiveSessionId } from '../core/ids.js'
import type { NoticeEntry } from '../model.js'
import { interruptTurn, steerTurn } from '../turn/control.js'
import { rpc } from '../wire/rpc.js'

/** What a control command needs from the app; commands/host.ts's sessionHost() supplies it. */
export interface ControlHost {
  gw: Pick<GatewayClient, 'request'>
  /** The open session's runtime id. */
  sid: LiveSessionId | null
  busy: boolean
  /** How many prompts wait on the next-prompt queue. */
  queued: number
  /** Submits `text` as a normal prompt: sent now when idle, queued behind the turn otherwise. */
  submit(text: string): void
  /** Puts `text` on the next-prompt queue. */
  enqueue(text: string): void
  notice(text: string, tone?: NoticeEntry['tone']): void
  /** Shows a steer the running turn accepted, in that turn. */
  steered?(text: string): void
}

export interface ControlCommand {
  name: string
  aliases?: readonly string[]
  run(host: ControlHost, arg: string): Promise<void> | void
}

const preview = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}…` : text)

async function steer(host: ControlHost, text: string) {
  if (!text) {
    return host.notice('Usage: /steer <guidance for the active turn>', 'warning')
  }

  if (!host.busy || !host.sid) {
    host.enqueue(text)

    return host.notice(`No active turn — queued as next prompt: ${preview(text)}`)
  }

  const r = await steerTurn(host.gw, host.sid, text)

  if (r.ok) {
    return host.steered ? host.steered(text) : host.notice(`Steer queued for the active turn: ${preview(text)}`)
  }

  if (r.error) {
    return host.notice(`/steer failed: ${r.error}`, 'error')
  }

  host.enqueue(text)
  host.notice('Turn ended before the steer landed — queued as next prompt', 'warning')
}

function queue(host: ControlHost, text: string) {
  if (!text) {
    return host.notice(`${host.queued} queued message${host.queued === 1 ? '' : 's'}`)
  }

  host.submit(text)
}

async function stop(host: ControlHost) {
  if (!host.sid) {
    return host.notice('No active session.', 'warning')
  }

  const notes: string[] = []

  if (host.busy) {
    try {
      await interruptTurn(host.gw, host.sid)
      notes.push('Interrupted the active turn.')
    } catch (e) {
      if (!errorText(e).includes('stale_generation')) {
        host.notice(`Interrupt failed: ${errorText(e)}`, 'error')
      }
    }
  }

  try {
    const r = await rpc(host.gw, 'process.stop', { session_id: host.sid })

    if (typeof r?.killed === 'number') {
      notes.push(`Stopped ${r.killed} background process${r.killed === 1 ? '' : 'es'}.`)
    }
  } catch {
    // Older gateways lack process.stop; the interrupt above is the essential part.
  }

  host.notice(notes.join(' ') || 'Nothing to stop.')
}

async function tools(host: ControlHost, arg: string) {
  const sub = arg.split(/\s+/)[0] ?? ''

  if (sub && sub !== 'list') {
    return host.notice(`/tools ${sub} is not available on the shared gateway yet (toolsets are fixed at session launch)`, 'warning')
  }

  if (!host.sid) {
    return host.notice('No active session.', 'warning')
  }

  try {
    // The owner's catalog for this session (toolsets, MCP and plugin tools), as Ink's /tools reads it.
    const r = await rpc(host.gw, 'tools.show', { session_id: host.sid })
    const sections = (r?.sections ?? []).filter(s => s.tools?.length)
    const lines = sections.map(s => `[${s.name}] ${s.tools.map(t => t.name).join(', ')}`)

    host.notice(lines.length ? [...lines, `Total: ${r?.total ?? 0} tools`].join('\n') : 'No tools available.')
  } catch (e) {
    host.notice(`/tools failed: ${errorText(e)}`, 'error')
  }
}

/**
 * `/bg <prompt>` and `/btw <question>`: a detached side agent on the session's route. The gateway
 * answers `{task_id}` now and the reply later as `background.complete` / `btw.complete`.
 */
async function side(host: ControlHost, text: string, kind: 'bg' | 'btw') {
  if (!text) {
    return host.notice(kind === 'bg' ? 'Usage: /bg <prompt>' : 'Usage: /btw <question>', 'warning')
  }

  if (!host.sid) {
    return host.notice('No active session.', 'warning')
  }

  try {
    const r = await rpc(host.gw, kind === 'bg' ? 'prompt.background' : 'prompt.btw', {
      session_id: host.sid,
      text
    })

    if (r?.task_id) {
      host.notice(
        kind === 'bg'
          ? `Background task ${r.task_id} started: ${preview(text)}`
          : `btw ${r.task_id}: answering from a snapshot of this conversation`
      )
    }
  } catch (e) {
    host.notice(`/${kind} failed: ${errorText(e)}`, 'error')
  }
}

export const CONTROL_COMMANDS: readonly ControlCommand[] = [
  { aliases: ['s'], name: 'steer', run: steer },
  { aliases: ['q'], name: 'queue', run: queue },
  { name: 'stop', run: stop },
  { name: 'tools', run: tools },
  { aliases: ['background'], name: 'bg', run: (host, arg) => side(host, arg, 'bg') },
  { name: 'btw', run: (host, arg) => side(host, arg, 'btw') }
]
