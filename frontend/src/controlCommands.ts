// Turn controls routed to the shared gateway's dedicated RPCs (session.steer,
// session.interrupt, process.stop, tools.show) instead of `slash.exec`.
// Mirrors Hermes' ui-tui/src/app/slash/commands/core.ts (/steer, /queue, /stop, /tools).
import type { GatewayClient } from '@tui/gatewayClient.js'

import { currentGeneration } from './hermes/mutate.js'
import type { NoticeEntry } from './model.js'

/** What a control command needs from the app; App.control() supplies it. */
export interface ControlHost {
  gw: Pick<GatewayClient, 'request'>
  sid: string | null
  busy: boolean
  /** Submits `text` as a normal prompt: sent now when idle, queued behind the turn otherwise. */
  submit(text: string): void
  /** Puts `text` on the next-prompt queue. */
  enqueue(text: string): void
  notice(text: string, tone?: NoticeEntry['tone']): void
}

export interface ControlCommand {
  name: string
  aliases?: readonly string[]
  run(host: ControlHost, arg: string): Promise<void> | void
}

const preview = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}…` : text)

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Interrupts session `sid`'s active turn, fenced by its execution generation. */
export async function interruptTurn(gw: ControlHost['gw'], sid: string) {
  const execution_generation = await currentGeneration(gw, sid)

  await gw.request('session.interrupt', { session_id: sid, execution_generation })
}

interface SteerResult {
  status?: string
}

async function steer(host: ControlHost, text: string) {
  if (!text) {
    return host.notice('Usage: /steer <guidance for the active turn>', 'warning')
  }

  if (!host.busy || !host.sid) {
    host.enqueue(text)

    return host.notice(`No active turn — queued as next prompt: ${preview(text)}`)
  }

  let status: string | undefined

  try {
    const execution_generation = await currentGeneration(host.gw, host.sid)
    const r = await host.gw.request<SteerResult | null>('session.steer', {
      session_id: host.sid,
      execution_generation,
      text
    })

    status = r?.status
  } catch (e) {
    if (!errorText(e).includes('stale_generation')) {
      return host.notice(`/steer failed: ${errorText(e)}`, 'error')
    }
  }

  if (status === 'queued') {
    return host.notice(`Steer queued for the active turn: ${preview(text)}`)
  }

  host.enqueue(text)
  host.notice('Turn ended before the steer landed — queued as next prompt', 'warning')
}

function queue(host: ControlHost, text: string) {
  if (!text) {
    return host.notice('Usage: /queue <prompt to run after the current turn>', 'warning')
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
    const r = await host.gw.request<{ killed?: number } | null>('process.stop', { session_id: host.sid })

    if (typeof r?.killed === 'number') {
      notes.push(`Stopped ${r.killed} background process${r.killed === 1 ? '' : 'es'}.`)
    }
  } catch {
    // Older gateways lack process.stop; the interrupt above is the essential part.
  }

  host.notice(notes.join(' ') || 'Nothing to stop.')
}

interface ToolsShowResult {
  sections?: { name: string; tools?: { name: string }[] }[]
  total?: number
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
    const r = await host.gw.request<ToolsShowResult | null>('tools.show', { session_id: host.sid })
    const sections = (r?.sections ?? []).filter(s => s.tools?.length)
    const lines = sections.map(s => `[${s.name}] ${s.tools!.map(t => t.name).join(', ')}`)

    host.notice(lines.length ? [...lines, `Total: ${r?.total ?? 0} tools`].join('\n') : 'No tools available.')
  } catch (e) {
    host.notice(`/tools failed: ${errorText(e)}`, 'error')
  }
}

export const CONTROL_COMMANDS: readonly ControlCommand[] = [
  { aliases: ['s'], name: 'steer', run: steer },
  // `/q` stays quit's alias here (Hermes' registry maps it to /queue).
  { name: 'queue', run: queue },
  { name: 'stop', run: stop },
  { name: 'tools', run: tools }
]
