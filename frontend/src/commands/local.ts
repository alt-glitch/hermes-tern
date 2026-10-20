// Slash commands this frontend runs itself: quitting, new sessions, the ones
// that open a native sheet (model, sessions, help), and the ones the shared
// gateway serves only through their own RPCs. Everything else goes to the
// gateway's `slash.exec`.

import type { ChatPorts } from '../app/ports.js'
import { copyToClipboard } from '../clipboard.js'
import { storedSessionId } from '../core/ids.js'
import type { Entry } from '../model.js'
import { type AgentsSheetHost, openAgents } from '../overlays/agents.js'
import { type BackgroundHost, openBackground } from '../overlays/background.js'
import { type ChangesHost, openChanges } from '../overlays/changes.js'
import { type EffortHost, openEffortPicker } from '../overlays/effort.js'
import { type ModelsHost, openModelPicker, switchModel } from '../overlays/models.js'
import { confirmOverlay } from '../overlays/prompts.js'
import { prsCommand, type PullRequestsSheetHost } from '../overlays/pullRequests.js'
import { openSessionPicker, type SessionsHost } from '../overlays/sessions.js'
import { isThemeMode, openThemePicker, type ThemeHost } from '../overlays/theme.js'
import { LEVELS } from '../session/effort.js'
import { fastCommand, type FastHost } from '../session/fast.js'
import { answerText } from '../view/transcript.js'
import { rpc } from '../wire/rpc.js'

import { CONTROL_COMMANDS } from './control.js'
import { REFUSED_COMMANDS, type RefusedHost } from './refused.js'
import { SESSION_COMMANDS } from './session.js'

/** What the commands reach of the app. */
export type CommandHost = Pick<
  ChatPorts,
  | 'agents'
  | 'attachClipboardImage'
  | 'attachImagePath'
  | 'busy'
  | 'control'
  | 'gw'
  | 'newSession'
  | 'open'
  | 'openHelp'
  | 'quit'
  | 'resume'
  | 'setEffort'
  | 'setTheme'
  | 'theme'
  | 'toggleSidebar'
  | 'transcript'
> &
  AgentsSheetHost &
  BackgroundHost &
  ChangesHost &
  EffortHost &
  FastHost &
  ModelsHost &
  PullRequestsSheetHost &
  RefusedHost &
  SessionsHost &
  ThemeHost

/** A client-side slash command. */
export interface LocalCommand {
  name: string
  aliases?: readonly string[]
  /**
   * The completion row and the help sheet's line. Only commands the gateway's catalog does not
   * list carry one: the rest mirror a gateway command that is already listed.
   */
  help?: string
  /**
   * Runs `/name arg`. Returning false hands the command to `slash.exec`
   * instead (a form this frontend leaves to the backend).
   */
  run(host: CommandHost, arg: string): boolean | void | Promise<boolean | void>
}

const COMMANDS: readonly LocalCommand[] = [
  {
    // `/q` is Hermes' /queue.
    aliases: ['exit'],
    name: 'quit',
    run: host => host.quit()
  },
  {
    // Hermes' `/clear` clears the screen AND starts a new session: the agent forgets the old one.
    aliases: ['reset', 'clear'],
    name: 'new',
    run: (host, arg) => {
      if (host.busy) {
        return host.transcript.notice('Wait for the current turn to finish (or press Esc twice) before starting a new session.', 'warning')
      }

      return host.newSession(arg.trim() || undefined)
    }
  },
  {
    name: 'model',
    run: async (host, arg) => {
      if (!arg) {
        return openModelPicker(host)
      }

      const r = await switchModel(host, arg)

      if (r.confirm_required) {
        host.open(
          confirmOverlay(host, {
            confirm: 'Switch anyway',
            detail: r.confirm_message || r.warning || '',
            onConfirm: () => void switchModel(host, arg, true),
            title: 'Switch to an expensive model?'
          })
        )
      }
    }
  },
  {
    aliases: ['resume', 'session', 'switch'],
    name: 'sessions',
    run: (host, arg) => {
      if (!arg) {
        return openSessionPicker(host)
      }

      // The argument names a stored session, as the picker's rows do.
      return arg === 'new' ? host.newSession() : host.resume(storedSessionId(arg))
    }
  },
  {
    help: 'Pick the colors: Tern, Nous or the Hermes skin [tern|nous|skin]',
    name: 'theme',
    run: (host, arg) => {
      if (!arg) {
        return openThemePicker(host)
      }

      if (!isThemeMode(arg)) {
        host.transcript.notice('Usage: /theme [tern|nous|skin]', 'warning')

        return
      }

      host.setTheme(arg)
    }
  },
  {
    // Ink's `/agents pause|resume|status`: the shared gateway's slash.exec refuses them.
    aliases: ['tasks'],
    name: 'agents',
    run: (host, arg) => agents(host, arg)
  },
  {
    // Hermes has no command by these names (its `/bg` runs a prompt in a side agent: control.ts).
    aliases: ['bashes', 'shells', 'processes'],
    help: 'Background processes and cron jobs',
    name: 'ps',
    run: host => openBackground(host)
  },
  {
    help: 'Pick the reasoning effort [level] [--global]',
    name: 'effort',
    run: (host, arg) => {
      const words = arg.trim().split(/\s+/).filter(Boolean)
      const global = words.includes('--global') || words.includes('default')
      const level = words.flatMap(w => LEVELS.find(l => l.id === w || l.label === w) ?? []).at(0)

      if (!level) {
        return openEffortPicker(host, global)
      }

      void host.setEffort(level.id, global ? 'global' : 'session')
    }
  },
  {
    // `/reasoning <level> [--global]` sets the level as the pill does (on the shared gateway, the
    // session mutation every viewer sees); its other forms (show, hide, status) stay the backend's.
    name: 'reasoning',
    run: (host, arg) => {
      const words = arg.trim().toLowerCase().split(/\s+/).filter(Boolean)
      const global = words.includes('--global')
      const rest = words.filter(w => w !== '--global')
      const level = rest.length === 1 ? LEVELS.find(l => l.id === rest[0] || l.label === rest[0]) : undefined

      if (!level) {
        return false
      }

      return void host.setEffort(level.id, global ? 'global' : 'session')
    }
  },
  {
    // The shared gateway sends no session.info after a typed /fast, so the bolt would not move.
    name: 'fast',
    run: (host, arg) => fastCommand(host, arg)
  },
  {
    // The shared gateway refuses /skin in slash.exec; Ink sets the profile's skin through config.set,
    // and the skin.changed broadcast repaints.
    name: 'skin',
    run: async (host, arg) => {
      if (!arg.trim()) {
        const r = await rpc(host.gw, 'config.get', { key: 'skin' })
        host.transcript.notice(`skin: ${r?.value || 'default'}`)
      } else {
        const r = await rpc(host.gw, 'config.set', { key: 'skin', value: arg.trim() })
        host.transcript.notice(`skin → ${r?.value || arg.trim()}`)
      }

      if (host.theme !== 'skin') {
        host.transcript.notice('Hermes wears the skin in the skin theme: /theme skin')
      }
    }
  },
  {
    // The Ink TUI's `/paste`: the clipboard's image on the next prompt.
    name: 'paste',
    run: (host, arg) => (arg ? host.transcript.notice('Usage: /paste', 'warning') : void host.attachClipboardImage(false))
  },
  {
    // Hermes' `/image <path>`: that file on the next prompt.
    name: 'image',
    run: (host, arg) => (arg.trim() ? host.attachImagePath(arg) : host.transcript.notice('Usage: /image <path>', 'warning'))
  },
  {
    aliases: ['side'],
    help: 'Show or hide the session sidebar: branch, PRs, changes',
    name: 'sidebar',
    run: host => host.toggleSidebar()
  },
  {
    aliases: ['diff'],
    help: 'The working tree changes, file by file',
    name: 'changes',
    run: host => openChanges(host)
  },
  {
    aliases: ['pr', 'pulls'],
    help: 'Pull requests Hermes linked, beside the chat (/prs 22 opens #22)',
    name: 'prs',
    run: (host, arg) => prsCommand(host, arg)
  },
  {
    // The gateway refuses its own /copy and /history (cli_only); Ink runs them on its transcript, as these do.
    name: 'copy',
    run: (host, arg) => copyAnswer(host, arg)
  },
  {
    name: 'history',
    run: (host, arg) => host.transcript.panel('/history', historyText(host.transcript.entries, arg))
  },
  {
    // `/help <command>` is the backend's detailed usage.
    name: 'help',
    run: (host, arg) => (arg ? false : host.openHelp())
  },
  ...CONTROL_COMMANDS.map(c => ({ ...c, run: (host: CommandHost, arg: string) => c.run(host.control(), arg) })),
  ...SESSION_COMMANDS.map(c => ({ ...c, run: (host: CommandHost, arg: string) => c.run(host.control(), arg) })),
  ...REFUSED_COMMANDS
]

/**
 * Commands the gateway lists that only the Ink TUI or a messaging platform runs (refused.ts):
 * this frontend neither offers nor resolves them, and answers one typed whole with why.
 */
export { HIDDEN_COMMANDS } from './refused.js'

/** `/copy [n]`: the last (or `n`th) answer to the clipboard. */
function copyAnswer(host: CommandHost, arg: string) {
  const n = arg.trim() ? Number.parseInt(arg, 10) : undefined

  if (n !== undefined && !(n >= 1)) {
    return host.transcript.notice('Usage: /copy [n] (n counts answers from the first)', 'warning')
  }

  const answers = host.transcript.entries.flatMap(e => (e.kind === 'turn' && answerText(e) ? [answerText(e)] : []))
  const at = n === undefined ? answers.length : Math.min(n, answers.length)
  const text = answers[at - 1]

  if (!text) {
    return host.transcript.notice('No answer to copy yet.', 'warning')
  }

  copyToClipboard(text)
  host.transcript.notice(`Copied ${n === undefined ? 'the last answer' : `answer ${at}`} (${text.length} characters).`)
}

/** `/history [chars]`: the conversation so far, each prompt and answer clipped to `chars` (Ink's preview). */
export function historyText(entries: readonly Entry[], arg: string): string {
  const preview = Math.max(80, Number.parseInt(arg, 10) || 400)
  let n = 0

  const lines = entries.flatMap(e => {
    if (e.kind !== 'user' && e.kind !== 'turn') {
      return []
    }

    const tools = e.kind === 'turn' ? e.blocks.filter(b => b.kind === 'tool').length : 0
    const said = e.kind === 'user' ? e.text.trim() : answerText(e)
    const body = said || (tools ? `(${tools} tool call${tools === 1 ? '' : 's'})` : '(empty)')
    const clipped = body.length > preview ? `${body.slice(0, preview).trimEnd()}…` : body

    return [`**${e.kind === 'user' ? 'You' : 'Hermes'} #${++n}**\n${clipped}`]
  })

  return lines.length ? lines.join('\n\n') : 'No conversation yet.'
}

/** `/agents` opens the hub; `pause|resume` gate new spawns gateway-wide (`delegation.pause`). */
async function agents(host: CommandHost, arg: string) {
  const sub = arg.trim().toLowerCase()

  if (!sub) {
    return openAgents(host)
  }

  if (sub === 'pause' || sub === 'resume' || sub === 'unpause') {
    const paused = await host.agents.pause(sub === 'pause')

    return host.transcript.notice(
      paused
        ? 'Subagent spawning paused for every chat on this gateway. Running agents keep going.'
        : 'Subagent spawning resumed.'
    )
  }

  if (sub === 'status') {
    const paused = host.agents.paused

    return host.transcript.notice(
      paused === undefined
        ? 'Subagent spawning: active, unless another client paused it (the gateway does not report it).'
        : `Subagent spawning: ${paused ? 'paused (gateway-wide)' : 'active'}.`
    )
  }

  host.transcript.notice('Usage: /agents [pause|resume|status]', 'warning')
}

/** The client-side command `name` (without the slash, any case) answers to, if any. */
export function localCommand(name: string): LocalCommand | undefined {
  const lower = name.toLowerCase()

  return COMMANDS.find(c => c.name === lower || c.aliases?.includes(lower))
}

/** Every client-side command; the ones with `help` are this frontend's own (completion, /help). */
export const localCommands = (): readonly LocalCommand[] => COMMANDS
