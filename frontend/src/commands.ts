// Slash commands this frontend runs itself: quitting, new sessions, the ones
// that open a native sheet (model, sessions, help), and the ones the shared
// gateway serves only through their own RPCs. Everything else goes to the
// gateway's `slash.exec`.

import type { App } from './app.js'
import { copyToClipboard } from './clipboard.js'
import { CONTROL_COMMANDS } from './controlCommands.js'
import { fastCommand } from './fast.js'
import type { Entry } from './model.js'
import { openAgents } from './overlays/agents.js'
import { openBackground } from './overlays/background.js'
import { openChanges } from './overlays/changes.js'
import { LEVELS, openEffortPicker } from './overlays/effort.js'
import { prsCommand } from './overlays/pullRequests.js'
import { openHelp } from './overlays/help.js'
import { openModelPicker, switchModel } from './overlays/models.js'
import { confirmOverlay } from './overlays/prompts.js'
import { openSessionPicker } from './overlays/sessions.js'
import { isThemeMode, openThemePicker } from './overlays/theme.js'
import { REFUSED_COMMANDS } from './refusedCommands.js'
import { SESSION_COMMANDS } from './sessionCommands.js'
import { answerText } from './view/transcript.js'

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
  run(app: App, arg: string): boolean | void | Promise<boolean | void>
}

const COMMANDS: readonly LocalCommand[] = [
  {
    // `/q` is Hermes' /queue.
    aliases: ['exit'],
    name: 'quit',
    run: app => app.quit()
  },
  {
    // Hermes' `/clear` clears the screen AND starts a new session: the agent forgets the old one.
    aliases: ['reset', 'clear'],
    name: 'new',
    run: (app, arg) => {
      if (app.busy) {
        return app.transcript.notice('Wait for the current turn to finish (or press Esc twice) before starting a new session.', 'warning')
      }

      return app.newSession(arg.trim() || undefined)
    }
  },
  {
    name: 'model',
    run: async (app, arg) => {
      if (!arg) {
        return openModelPicker(app)
      }

      const r = await switchModel(app, arg)

      if (r.confirm_required) {
        app.open(
          confirmOverlay(app, {
            confirm: 'Switch anyway',
            detail: r.confirm_message || r.warning || '',
            onConfirm: () => void switchModel(app, arg, true),
            title: 'Switch to an expensive model?'
          })
        )
      }
    }
  },
  {
    aliases: ['resume', 'session', 'switch'],
    name: 'sessions',
    run: (app, arg) => {
      if (!arg) {
        return openSessionPicker(app)
      }

      return arg === 'new' ? app.newSession() : app.resume(arg)
    }
  },
  {
    help: 'Pick the colors: Tern, Nous or the Hermes skin [tern|nous|skin]',
    name: 'theme',
    run: (app, arg) => {
      if (!arg) {
        return openThemePicker(app)
      }

      if (!isThemeMode(arg)) {
        app.transcript.notice('Usage: /theme [tern|nous|skin]', 'warning')

        return
      }

      app.setTheme(arg)
    }
  },
  {
    // Ink's `/agents pause|resume|status`: the shared gateway's slash.exec refuses them.
    aliases: ['tasks'],
    name: 'agents',
    run: (app, arg) => agents(app, arg)
  },
  {
    // Hermes has no command by these names (its `/bg` runs a prompt in a side agent: controlCommands.ts).
    aliases: ['bashes', 'shells', 'processes'],
    help: 'Background processes and cron jobs',
    name: 'ps',
    run: app => openBackground(app)
  },
  {
    help: 'Pick the reasoning effort [level] [--global]',
    name: 'effort',
    run: (app, arg) => {
      const words = arg.trim().split(/\s+/).filter(Boolean)
      const global = words.includes('--global') || words.includes('default')
      const level = words.find(w => LEVELS.some(l => l.id === w || l.label === w))

      if (!level) {
        return openEffortPicker(app, global)
      }

      void app.setEffort(LEVELS.find(l => l.id === level || l.label === level)!.id, global ? 'global' : 'session')
    }
  },
  {
    // `/reasoning <level> [--global]` sets the level as the pill does (on the shared gateway, the
    // session mutation every viewer sees); its other forms (show, hide, status) stay the backend's.
    name: 'reasoning',
    run: (app, arg) => {
      const words = arg.trim().toLowerCase().split(/\s+/).filter(Boolean)
      const global = words.includes('--global')
      const rest = words.filter(w => w !== '--global')
      const level = rest.length === 1 ? LEVELS.find(l => l.id === rest[0] || l.label === rest[0]) : undefined

      if (!level) {
        return false
      }

      return void app.setEffort(level.id, global ? 'global' : 'session')
    }
  },
  {
    // The shared gateway sends no session.info after a typed /fast, so the bolt would not move.
    name: 'fast',
    run: (app, arg) => fastCommand(app, arg)
  },
  {
    // The shared gateway refuses /skin in slash.exec; Ink sets the profile's skin through config.set,
    // and the skin.changed broadcast repaints.
    name: 'skin',
    run: async (app, arg) => {
      if (!arg.trim()) {
        const r = await app.gw.request<{ value?: string }>('config.get', { key: 'skin' })
        app.transcript.notice(`skin: ${r?.value || 'default'}`)
      } else {
        const r = await app.gw.request<{ value?: string }>('config.set', { key: 'skin', value: arg.trim() })
        app.transcript.notice(`skin → ${r?.value || arg.trim()}`)
      }

      if (app.theme !== 'skin') {
        app.transcript.notice('Hermes wears the skin in the skin theme: /theme skin')
      }
    }
  },
  {
    // The Ink TUI's `/paste`: the clipboard's image on the next prompt.
    name: 'paste',
    run: (app, arg) => (arg ? app.transcript.notice('Usage: /paste', 'warning') : void app.attachClipboardImage(false))
  },
  {
    // Hermes' `/image <path>`: that file on the next prompt.
    name: 'image',
    run: (app, arg) => (arg.trim() ? app.attachImagePath(arg) : app.transcript.notice('Usage: /image <path>', 'warning'))
  },
  {
    aliases: ['side'],
    help: 'Show or hide the session sidebar: branch, PRs, changes',
    name: 'sidebar',
    run: app => app.toggleSidebar()
  },
  {
    aliases: ['diff'],
    help: 'The working tree changes, file by file',
    name: 'changes',
    run: app => openChanges(app)
  },
  {
    aliases: ['pr', 'pulls'],
    help: 'Pull requests Hermes linked, beside the chat (/prs 22 opens #22)',
    name: 'prs',
    run: (app, arg) => prsCommand(app, arg)
  },
  {
    // The gateway refuses its own /copy and /history (cli_only); Ink runs them on its transcript, as these do.
    name: 'copy',
    run: (app, arg) => copyAnswer(app, arg)
  },
  {
    name: 'history',
    run: (app, arg) => app.transcript.panel('/history', historyText(app.transcript.entries, arg))
  },
  {
    // `/help <command>` is the backend's detailed usage.
    name: 'help',
    run: (app, arg) => (arg ? false : openHelp(app))
  },
  ...CONTROL_COMMANDS.map(c => ({ ...c, run: (app: App, arg: string) => c.run(app.control(), arg) })),
  ...SESSION_COMMANDS.map(c => ({ ...c, run: (app: App, arg: string) => c.run(app.control(), arg) })),
  ...REFUSED_COMMANDS
]

/**
 * Commands the gateway lists that only the Ink TUI or a messaging platform runs (refusedCommands.ts):
 * this frontend neither offers nor resolves them, and answers one typed whole with why.
 */
export { HIDDEN_COMMANDS } from './refusedCommands.js'

/** `/copy [n]`: the last (or `n`th) answer to the clipboard. */
function copyAnswer(app: App, arg: string) {
  const n = arg.trim() ? Number.parseInt(arg, 10) : undefined

  if (n !== undefined && !(n >= 1)) {
    return app.transcript.notice('Usage: /copy [n] (n counts answers from the first)', 'warning')
  }

  const answers = app.transcript.entries.flatMap(e => (e.kind === 'turn' && answerText(e) ? [answerText(e)] : []))
  const at = n === undefined ? answers.length : Math.min(n, answers.length)
  const text = answers[at - 1]

  if (!text) {
    return app.transcript.notice('No answer to copy yet.', 'warning')
  }

  copyToClipboard(text)
  app.transcript.notice(`Copied ${n === undefined ? 'the last answer' : `answer ${at}`} (${text.length} characters).`)
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
async function agents(app: App, arg: string) {
  const sub = arg.trim().toLowerCase()

  if (!sub) {
    return openAgents(app)
  }

  if (sub === 'pause' || sub === 'resume' || sub === 'unpause') {
    const paused = await app.agents.pause(sub === 'pause')

    return app.transcript.notice(
      paused
        ? 'Subagent spawning paused for every chat on this gateway. Running agents keep going.'
        : 'Subagent spawning resumed.'
    )
  }

  if (sub === 'status') {
    const paused = app.agents.paused

    return app.transcript.notice(
      paused === undefined
        ? 'Subagent spawning: active, unless another client paused it (the gateway does not report it).'
        : `Subagent spawning: ${paused ? 'paused (gateway-wide)' : 'active'}.`
    )
  }

  app.transcript.notice('Usage: /agents [pause|resume|status]', 'warning')
}

/** The client-side command `name` (without the slash, any case) answers to, if any. */
export function localCommand(name: string): LocalCommand | undefined {
  const lower = name.toLowerCase()

  return COMMANDS.find(c => c.name === lower || c.aliases?.includes(lower))
}

/** Every client-side command; the ones with `help` are this frontend's own (completion, /help). */
export const localCommands = (): readonly LocalCommand[] => COMMANDS
