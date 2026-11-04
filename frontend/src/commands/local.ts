// Slash commands this frontend runs itself: quitting, new sessions, the ones
// that open a native sheet (model, sessions, help), and the ones the shared
// gateway serves only through their own RPCs. Everything else goes to the
// gateway's `slash.exec`.

import type { ChatPorts } from '../app/ports.js'
import { openArtifact } from '../artifacts.js'
import { copyToClipboard } from '../clipboard.js'
import { storedSessionId } from '../core/ids.js'
import type { Entry } from '../model.js'
import { forkSession } from '../fork-session.js'
import { type AgentsSheetHost, openAgents } from '../overlays/agents.js'
import { type BackgroundHost, openBackground } from '../overlays/background.js'
import { openBrowserBlocks } from '../overlays/browser.js'
import { type ChangesHost, openChanges } from '../overlays/changes.js'
import { type EffortHost, openEffortPicker } from '../overlays/effort.js'
import { type ModelsHost, openModelPicker, switchModel } from '../overlays/models.js'
import { openModelHub } from '../overlays/modelHub.js'
import { type PlanReviewHost, openPlanReview } from '../overlays/plan.js'
import { confirmOverlay } from '../overlays/prompts.js'
import { prsCommand, type PullRequestsSheetHost } from '../overlays/pullRequests.js'
import { openRewind } from '../overlays/rewind.js'
import { openSessionPicker, type SessionsHost } from '../overlays/sessions.js'
import { openSettings } from '../overlays/settings.js'
import { openToolResults } from '../overlays/toolResults.js'
import { isThemeMode, openThemePicker, type ThemeHost } from '../overlays/theme.js'
import { type VisualPickerHost, openVisualPicker } from '../overlays/visualPicker.js'
import { openBranchTree } from '../overlays/tree.js'
import { LEVELS } from '../session/effort.js'
import { fastCommand, type FastHost } from '../session/fast.js'
import { answerText } from '../transcript/turns.js'
import { HOLD_UNAVAILABLE } from '../voice/hold.js'
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
  | 'btw'
  | 'operations'
  | 'control'
  | 'gw'
  | 'liveVoice'
  | 'editExternal'
  | 'newSession'
  | 'open'
  | 'openHelp'
  | 'openNotices'
  | 'openPalette'
  | 'overlays'
  | 'quit'
  | 'resume'
  | 'session'
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
  PlanReviewHost &
  PullRequestsSheetHost &
  RefusedHost &
  SessionsHost &
  ThemeHost &
  VisualPickerHost

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
  run(host: CommandHost, arg: string, literal?: boolean): boolean | void | Promise<boolean | void>
}

const COMMANDS: readonly LocalCommand[] = [
  {
    name: 'notices',
    help: 'Inspect retained gateway notices',
    run: host => host.openNotices()
  },
  {
    name: 'tool-results',
    help: 'Inspect retained generic and web page text',
    run: host => openToolResults(host)
  },
  {
    help: 'Opt-in live conversation (Alt+Shift+V), separate from /voice dictation',
    name: 'live',
    run: (host, arg) => {
      if (arg && arg !== 'status' && arg !== 'off') {
        return host.transcript.notice('Usage: /live [status|off]', 'warning')
      }
      if (arg === 'status') {
        return host.transcript.notice('Live voice: ' + host.liveVoice.phase)
      }
      if (arg === 'off') {
        void host.liveVoice.control('stop')
        return
      }
      host.liveVoice.toggle()
    }
  },
  {
    help: 'Why physical hold-to-talk is unavailable (Alt+Shift+Space)',
    name: 'ptt',
    run: host => host.transcript.notice(HOLD_UNAVAILABLE, 'warning')
  },
  {
    help: 'Edit the current draft in Tern or $VISUAL/$EDITOR',
    name: 'editor',
    run: (host, arg) => arg.trim() ? host.transcript.notice('Usage: /editor', 'warning') : host.editExternal()
  },
  {
    help: 'Open a rotatable model beside the chat: /view3d PATH|URL',
    name: 'view3d',
    run: async (host, arg) => {
      const source = arg.trim().replace(/^(["'])(.*)\1$/, '$2')
      if (!source) {
        host.transcript.notice('Usage: /view3d PATH|URL (.glb, .gltf, .obj, .fbx, .usdz)', 'warning')
        return
      }
      try {
        await openArtifact(source, host.session.info?.cwd)
      } catch {
        host.transcript.notice('Could not open the 3D model. Check the path, format, or public download URL.', 'warning')
      }
    }
  },
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
    name: 'palette',
    help: 'Search and run commands, or insert one into the composer',
    run: host => host.openPalette()
  },
  {
    name: 'settings',
    help: 'Native Hermes profile preferences and live-session controls',
    run: host => openSettings(host)
  },
  {
    name: 'prefs',
    help: 'Open Hermes settings (alias of /settings)',
    run: host => openSettings(host)
  },
  {
    name: 'models',
    help: 'Inspect Hermes providers and profile model-management availability',
    run: host => openModelHub(host)
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
    name: 'plan',
    help: 'Review the latest plan; /plan <task> still generates a plan via Hermes',
    run: (host, arg) => (arg.trim() ? false : openPlanReview(host))
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
    help: 'Inspect or manage Tern browser blocks (requires Hermes browser-block RPCs)',
    name: 'browser-blocks',
    run: host => openBrowserBlocks(host)
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
    help: 'Inspect a prepared OpenUI preview [/absolute/path/to/file.hvisual.json]',
    name: 'visual',
    run: (host, arg) => openVisualPicker(host, arg.trim())
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
    name: 'fork',
    help: 'Fork the conversation into another Tern pane [/fork [durable-message-id]]',
    run: (host, arg) => forkSession(host, arg)
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
    help: 'Go back to an earlier prompt: rewind to it, or branch from it',
    name: 'rewind',
    run: host => openRewind(host)
  },
  {
    help: "This conversation's branches as a tree: open one",
    name: 'tree',
    run: host => openBranchTree(host)
  },
  {
    // The gateway refuses its own /copy and /history (cli_only); Ink runs them on its transcript, as these do.
    name: 'copy',
    run: (host, arg) => copyAnswer(host, arg)
  },
  {
    name: 'history',
    run: (host, arg) => host.operations.showText('/history', historyText(host.transcript.entries, arg))
  },
  {
    // `/help <command>` is the backend's detailed usage.
    name: 'help',
    run: (host, arg) => (arg ? false : host.openHelp())
  },
  // The history-capable sheet supersedes CONTROL_COMMANDS' legacy one-shot /btw route.
  { name: 'btw', run: (host, arg) => host.btw.show(arg) },
  { name: 'mcp', run: (host, arg) => host.operations.show('mcp', arg) },
  { name: 'ssh', run: (host, arg) => host.operations.show('ssh', arg) },
  {
    name: 'tools',
    run: (host, arg) => {
      const query = arg.trim().toLowerCase()

      if (query === '' || query === 'list') {
        return host.operations.showTools(query)
      }

      return CONTROL_COMMANDS.find(c => c.name === 'tools')?.run(host.control(), arg)
    }
  },
  ...CONTROL_COMMANDS.filter(c => c.name !== 'tools').map(c => ({
    ...c, run: (host: CommandHost, arg: string, literal?: boolean) => c.run(host.control(literal), arg)
  })),
  ...SESSION_COMMANDS.map(c => ({ ...c, run: (host: CommandHost, arg: string, literal?: boolean) => c.run(host.control(literal), arg) })),
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

