// Slash commands this frontend runs itself: quitting, clearing, and the ones
// that open a native sheet (model, sessions, help). Everything else goes to
// the gateway's `slash.exec`.

import type { App } from './app.js'
import { CONTROL_COMMANDS } from './controlCommands.js'
import { openAgents } from './overlays/agents.js'
import { openBackground } from './overlays/background.js'
import { openChanges } from './overlays/changes.js'
import { LEVELS, openEffortPicker } from './overlays/effort.js'
import { openPullRequests } from './overlays/pullRequests.js'
import { openHelp } from './overlays/help.js'
import { openModelPicker, switchModel } from './overlays/models.js'
import { confirmOverlay } from './overlays/prompts.js'
import { openSessionPicker } from './overlays/sessions.js'
import { isThemeMode, openThemePicker } from './overlays/theme.js'

/** A client-side slash command. */
export interface LocalCommand {
  name: string
  aliases?: readonly string[]
  /**
   * Runs `/name arg`. Returning false hands the command to `slash.exec`
   * instead (a form this frontend leaves to the backend).
   */
  run(app: App, arg: string): boolean | void | Promise<boolean | void>
}

const COMMANDS: readonly LocalCommand[] = [
  {
    aliases: ['exit', 'q'],
    name: 'quit',
    run: app => app.quit()
  },
  {
    aliases: ['reset'],
    name: 'new',
    run: app => app.newSession()
  },
  {
    name: 'clear',
    run: app => {
      app.transcript.clear()
      app.transcript.push({ id: app.transcript.id('w'), kind: 'welcome' })
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
    // `/agents pause|resume|status` stay the backend's (delegation.pause and its status).
    aliases: ['tasks'],
    name: 'agents',
    run: (app, arg) => (arg ? false : openAgents(app))
  },
  {
    // Hermes has no command by these names (its `/bg` runs a prompt in a background session).
    aliases: ['bashes', 'shells', 'processes'],
    name: 'ps',
    run: app => openBackground(app)
  },
  {
    // Hermes' own `/reasoning` stays the backend's (show/hide, levels, --global).
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
    // The shared gateway refuses /compress in slash.exec; a private gateway still runs it there.
    name: 'compress',
    run: (app, arg) => app.compress(arg)
  },
  {
    // The Ink TUI's `/paste`: the clipboard's image on the next prompt.
    aliases: ['image'],
    name: 'paste',
    run: (app, arg) => (arg ? false : void app.attachClipboardImage(false))
  },
  {
    aliases: ['side'],
    name: 'sidebar',
    run: app => app.toggleSidebar()
  },
  {
    aliases: ['diff'],
    name: 'changes',
    run: app => openChanges(app)
  },
  {
    aliases: ['pr', 'pulls'],
    name: 'prs',
    run: app => openPullRequests(app)
  },
  {
    // `/help <command>` is the backend's detailed usage.
    name: 'help',
    run: (app, arg) => (arg ? false : openHelp(app))
  },
  ...CONTROL_COMMANDS.map(c => ({ ...c, run: (app: App, arg: string) => c.run(app.control(), arg) }))
]

/** The client-side command `name` (without the slash) answers to, if any. */
export function localCommand(name: string): LocalCommand | undefined {
  return COMMANDS.find(c => c.name === name || c.aliases?.includes(name))
}
