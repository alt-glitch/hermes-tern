// A typed `/name arg`: run here when this frontend owns the command (local.ts), else resolved
// through the gateway's catalog and sent to `slash.exec` (or `command.dispatch`, for a command
// slash.exec does not own). The answer's envelope then shows output, sends a skill or message,
// follows an alias or fills the composer.

import { type CommandDispatchResponse, parseCommandDispatch } from '@hermes/shared/slash'

import { errorText } from '../core/errors.js'
import type { Attachments } from '../draft/attachments.js'
import type { Composer } from '../draft/composer.js'
import { dispatchError, execRefusal } from '../hermes/slashErrors.js'
import type { SessionLifecycle } from '../session/lifecycle.js'
import type { Transcript } from '../transcript/store.js'
import type { Prompt } from '../turn/prompt.js'
import { type Requester, rpc } from '../wire/rpc.js'

import { type CommandHost, localCommand } from './local.js'
import { ambiguousNotice, type CommandCatalog, resolveSlashName } from './resolve.js'

/** What running a slash command reaches of the app. */
export interface SlashCx {
  /** What this frontend's own commands reach (the app's ports). */
  readonly host: CommandHost
  /** `commands.catalog`, for resolving a typed alias or prefix (`/hea` → /heartbeat). */
  readonly catalog: Pick<CommandCatalog, 'get' | 'reset'>
  readonly gw: Requester
  readonly life: Pick<SessionLifecycle, 'replyTicket'>
  readonly transcript: Pick<Transcript, 'notice' | 'panel'>
  readonly composer: Pick<Composer, 'set'>
  /** The draft's images: a skill or message the command sends takes them. */
  readonly attachments: Pick<Attachments, 'take'>
  changed(): void
  /** A prompt the command made (a skill, a `send`): while a turn runs it takes the busy path a typed one does. */
  prompt(item: Prompt): void
}

/**
 * A slash.exec / command.dispatch answer, read once: the dispatch union, or an older backend's
 * bare `output`; and a `warning` either may carry. A field that is not a string is left out.
 */
export interface CommandEnvelope {
  dispatch: CommandDispatchResponse | null
  output: string | undefined
  warning: string | undefined
}

/** Reads a command's answer into its envelope. */
export function commandEnvelope(raw: unknown): CommandEnvelope {
  const legacy = raw && typeof raw === 'object' ? raw : {}

  return {
    dispatch: parseCommandDispatch(raw),
    output: 'output' in legacy && typeof legacy.output === 'string' ? legacy.output : undefined,
    warning: 'warning' in legacy && typeof legacy.warning === 'string' ? legacy.warning : undefined
  }
}

/** Runs `/name arg`; `resolve`: expand a typed alias or prefix through the catalog first. */
export async function runSlash(text: string, cx: SlashCx, resolve = true): Promise<void> {
  const [typed = '', ...rest] = text.slice(1).split(/\s+/)
  const name = typed.toLowerCase()
  const arg = rest.join(' ')
  const local = localCommand(name)

  if (local) {
    try {
      const handled = await local.run(cx.host, arg)

      if (local.name === 'reload-skills') {
        cx.catalog.reset()
      }

      if (handled !== false) {
        return cx.changed()
      }
    } catch (error) {
      cx.transcript.notice(errorText(error), 'error')

      return cx.changed()
    }
  }

  // The reply belongs to the session it was typed in: once the view left it, or a switch begun since
  // is in flight, the reply is dropped (Ink's stale()), so a late skill or /plan never sends its prompt
  // to the next session.
  const ticket = cx.life.replyTicket()
  const { sid } = ticket
  const stale = () => !ticket.isCurrent()

  if (resolve) {
    // Sessionless (starting, or the backend is down), only this frontend's own commands resolve.
    const to = resolveSlashName(name, sid ? await cx.catalog.get(sid) : undefined)

    if (stale()) {
      return
    }

    if (to && 'ambiguous' in to) {
      cx.transcript.notice(ambiguousNotice(name, to.ambiguous), 'warning')

      return cx.changed()
    }

    if (to) {
      return runSlash(`/${to.name}${arg ? ` ${arg}` : ''}`, cx, false)
    }
  }

  if (!sid) {
    return
  }

  const title = `/${name}${arg ? ` ${arg}` : ''}`

  try {
    const r = await rpc(cx.gw, 'slash.exec', { command: text.slice(1), session_id: sid })

    if (stale()) {
      return
    }

    await dispatched(r, cx, { arg, title })
  } catch (error) {
    if (stale()) {
      return
    }

    const refusal = execRefusal(name, error)

    if (refusal.kind === 'notice') {
      cx.transcript.notice(refusal.text, refusal.tone)
    } else {
      try {
        const r = await rpc(cx.gw, 'command.dispatch', { arg, name, session_id: sid })

        if (stale()) {
          return
        }

        await dispatched(r, cx, { arg, title })
      } catch (dispatchFailure) {
        if (stale()) {
          return
        }

        cx.transcript.notice(dispatchError(name, dispatchFailure), 'error')
      }
    }
  }

  cx.changed()
}

/**
 * Acts on a slash.exec / command.dispatch answer: output, a skill or message to send, an alias
 * or a prefill. `title` heads its output panel; `arg` follows an alias.
 */
export async function dispatched(raw: unknown, cx: SlashCx, { arg, title }: { arg: string; title: string }): Promise<void> {
  const { dispatch: d, output, warning } = commandEnvelope(raw)

  if (warning) {
    cx.transcript.notice(warning, 'warning')
  }

  if (!d) {
    if (output?.trim()) {
      cx.transcript.panel(title, output)
    }

    return
  }

  switch (d.type) {
    case 'exec':

    case 'plugin':
      if (d.output?.trim()) {
        cx.transcript.panel(title, d.output)
      }

      return

    case 'alias':
      return runSlash(`/${d.target}${arg ? ` ${arg}` : ''}`, cx)

    case 'skill':
      // `message` is the expanded skill body for the model; the transcript shows the invocation.
      return d.message?.trim()
        ? cx.prompt({ display: d.display || title, images: cx.attachments.take(), kind: 'command', text: d.message })
        : cx.transcript.notice(`${title}: the skill sent no message`, 'error')

    case 'send':
      if (d.notice?.trim()) {
        cx.transcript.notice(d.notice)
      }

      return d.message?.trim() ? cx.prompt({ display: d.display, images: cx.attachments.take(), kind: 'command', text: d.message }) : undefined

    case 'prefill':
      if (d.notice?.trim()) {
        cx.transcript.notice(d.notice)
      }

      cx.composer.set(d.message)
  }
}
