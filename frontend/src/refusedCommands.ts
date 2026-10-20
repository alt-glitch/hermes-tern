// Registry commands the shared gateway's `slash.exec` refuses (gateway/session_commands.py
// `command_verdict`) that no sheet or session RPC elsewhere serves. Some run here: /cron opens the
// Background sheet, /browser, /plugins and /subscription read their own RPCs (as Ink's ops.ts,
// pluginsHub.tsx and subscription.ts do), /config and /worktree run `hermes …` through `cli.exec`,
// /snapshot create runs `hermes backup --quick`, /update opens a split running `hermes update`.
// The rest are Ink-TUI-only or messaging-only: hidden from completion and /help, and typing one
// anyway says why in a line instead of the gateway's generic refusal.

import type {
  AgentPluginRow,
  CurrentSubscription,
  SubscriptionStateResult,
  SubscriptionTierOption,
  UsageModel
} from '@hermes/shared/gateway-events'

import type { ChatPorts } from './app/ports.js'
import { oneOf } from './core/assert.js'
import { errorText } from './core/errors.js'
import type { NoticeEntry } from './model.js'
import { type BackgroundHost, openBackground } from './overlays/background.js'
import { openHermesSplit } from './watch/spec.js'
import { type ResultOf, rpc } from './wire/rpc.js'

/** What these commands reach of the app. */
export type RefusedHost = Pick<ChatPorts, 'gw' | 'session' | 'transcript'> & BackgroundHost

/** A command this module answers: commands.ts's LocalCommand, on the ports these commands reach. */
export interface RefusedCommand {
  name: string
  aliases?: readonly string[]
  /** Runs `/name arg`; false hands it to `slash.exec`. */
  run(host: RefusedHost, arg: string): boolean | void | Promise<boolean | void>
}

const words = (arg: string) => arg.trim().split(/\s+/).filter(Boolean)

/** `hermes <argv>` on the gateway host, headless; its output in a panel titled `title`. */
async function cliPanel(host: RefusedHost, title: string, argv: string[]) {
  const r = await rpc(host.gw, 'cli.exec', { argv })

  if (r?.blocked) {
    return host.transcript.notice(r.hint || `\`hermes ${argv.join(' ')}\` cannot run here.`, 'warning')
  }

  host.transcript.panel(title, r?.output?.trim() || '(no output)')

  if (r?.code) {
    host.transcript.notice(`\`hermes ${argv.join(' ')}\` exited with code ${r.code}.`, 'warning')
  }
}

const isBrowserAction = oneOf(['connect', 'disconnect', 'status', 'use'])

/** `/browser [status|use [on|off]|connect [url]|disconnect]`, as Ink's ops.ts sends it. */
async function browser(host: RefusedHost, arg: string) {
  const [first = 'status', ...rest] = words(arg)
  const action = first.toLowerCase()
  const note = (text: string, tone?: NoticeEntry['tone']) => host.transcript.notice(text, tone)

  if (!isBrowserAction(action)) {
    return note('Usage: /browser [status|use [on|off]|connect [url]|disconnect]', 'warning')
  }

  const mode = action === 'use' ? (rest[0] ?? 'on').toLowerCase() : undefined

  if (mode && mode !== 'on' && mode !== 'off') {
    return note('Usage: /browser use [on|off]', 'warning')
  }

  const url = action === 'connect' ? rest.join(' ').trim() || 'http://127.0.0.1:9222' : undefined
  let r: ResultOf<'browser.manage'>

  try {
    r = await rpc(host.gw, 'browser.manage', {
      action,
      session_id: host.session.ref.live,
      ...(url ? { url } : {}),
      ...(mode ? { enabled: mode === 'on' } : {})
    })
  } catch (e) {
    // The shared gateway refuses connect/disconnect (they would switch every chat's browser) and says what to do instead.
    return note(errorText(e), 'warning')
  }

  if (action === 'use') {
    return note(
      `${mode === 'on' ? 'Browser Use mode on: browser_exec runs through the Browser Use CLI.' : 'Browser Use mode off: the built-in browser tools are back.'} New sessions get it; this one keeps its tools (/new starts one).`
    )
  }

  if (action === 'disconnect') {
    return note('Browser disconnected.')
  }

  if (action === 'connect') {
    // A private gateway narrates the connect in `messages` (this frontend reads no browser.progress).
    const said = r?.messages?.join('\n')
    const done = r?.connected
      ? `Browser connected over CDP: ${r.url || url}. The next browser tool call uses it.`
      : `No browser answered at ${url}.`

    return note(said ? `${said}\n${done}` : done, r?.connected ? 'info' : 'warning')
  }

  note(
    [
      r?.connected
        ? `Browser connected: ${r.url || '(url unavailable)'}`
        : 'Browser not connected (set browser.cdp_url in config.yaml to attach one).',
      ...(r?.browser_use ? ['Browser Use mode: browser_exec runs through the Browser Use CLI.'] : [])
    ].join('\n')
  )
}

/** What a plugin's line reads of its `plugins.manage` row. */
type PluginRow = Pick<AgentPluginRow, 'name'> & Partial<Pick<AgentPluginRow, 'description' | 'source' | 'status' | 'version'>>

/** One Markdown line per plugin: ✓ enabled, ✗ disabled, else its status in words. */
export function pluginLines(rows: readonly PluginRow[]): string[] {
  const mark = (status = '') => (status === 'enabled' ? '✓' : status === 'disabled' ? '✗' : '·')

  return rows.map(p => {
    const facts = [p.version, p.source, p.status === 'enabled' || p.status === 'disabled' ? '' : p.status]
      .filter(Boolean)
      .join(', ')

    return `- ${mark(p.status)} **${p.name}**${facts ? ` (${facts})` : ''}${p.description ? ` — ${p.description}` : ''}`
  })
}

/**
 * `/plugins [list|all]`: the Plugins Hub's own list (`plugins.manage list`), user plugins first as
 * the hub shows them. Ink sends the changing subcommands to `slash.exec`, which the shared gateway refuses.
 */
async function plugins(host: RefusedHost, arg: string) {
  const sub = (words(arg)[0] ?? 'list').toLowerCase()

  if (sub !== 'list' && sub !== 'ls' && sub !== 'all') {
    return host.transcript.notice(
      `Usage: /plugins [list|all]. To ${sub} a plugin, run \`hermes plugins ${sub} …\` in a terminal.`,
      'warning'
    )
  }

  const r = await rpc(host.gw, 'plugins.manage', { action: 'list' })
  const rows = r?.plugins ?? []
  const user = rows.filter(p => p.source !== 'bundled')
  // No user plugins: the bundled ones, so the list is never empty when some exist (as the hub falls back).
  const shown = sub === 'all' || !user.length ? rows : user
  const hidden = rows.length - shown.length

  if (!rows.length) {
    return host.transcript.notice('No plugins installed.')
  }

  host.transcript.panel(
    'Plugins',
    [
      ...pluginLines(shown),
      ...(hidden ? ['', `${hidden} bundled plugin${hidden === 1 ? '' : 's'} not shown: /plugins all lists them.`] : [])
    ].join('\n')
  )
}

/** What the `/subscription` panel reads of `subscription.state`: any field may be missing. */
type SubscriptionState = Partial<Pick<SubscriptionStateResult, 'can_change_plan' | 'org_id' | 'org_name' | 'portal_url' | 'role'>> & {
  current?: Partial<CurrentSubscription> | null
  tiers?: Partial<SubscriptionTierOption>[] | null
  usage?: Partial<UsageModel> | null
}

/** Ink's buildManageUrl: `<portal origin>/manage-subscription?org_id=…`, or null without a portal. */
export function manageUrl(s: Pick<SubscriptionState, 'org_id' | 'portal_url'>): string | null {
  try {
    const url = new URL('/manage-subscription', new URL(s.portal_url ?? '').origin)

    if (s.org_id) {
      url.searchParams.set('org_id', s.org_id)
    }

    return url.toString()
  } catch {
    return null
  }
}

/** The `/subscription` panel: the plan, its credits and what is pending, and where to change it. */
export function subscriptionText(s: SubscriptionState): string {
  const c = s.current
  const price = s.tiers?.find(t => t.is_current)?.dollars_per_month_display
  const url = manageUrl(s)
  const lines = [
    `**Plan:** ${c?.tier_name || 'none'}${price ? ` (${price} / month)` : ''}`,
    ...(c?.credits_remaining && c.monthly_credits
      ? [`**Credits:** ${c.credits_remaining} of ${c.monthly_credits} left this cycle`]
      : []),
    ...(s.usage?.renews_display ? [`**Renews:** ${s.usage.renews_display}`] : []),
    ...(s.org_name ? [`**Account:** ${s.org_name}${s.role ? ` (${s.role})` : ''}`] : []),
    ...(c?.pending_downgrade_tier_name
      ? [
          `Changes to ${c.pending_downgrade_tier_name}${c.pending_downgrade_display ? ` ${c.pending_downgrade_display}` : ''}.`
        ]
      : []),
    ...(c?.cancel_at_period_end
      ? [
          `Cancels${c.cancellation_effective_display ? ` ${c.cancellation_effective_display}` : ' at the end of the cycle'}.`
        ]
      : [])
  ]
  const change =
    s.can_change_plan === false
      ? 'Only an admin of this account can change the plan.'
      : url
        ? `[Change your plan](${url}) on the Nous Portal.`
        : 'Change your plan on the Nous Portal.'

  return [...lines, '', change].join('\n')
}

async function subscription(host: RefusedHost) {
  const s = await rpc(host.gw, 'subscription.state', {})

  if (!s?.logged_in) {
    return host.transcript.notice(
      s?.error
        ? `Could not load the subscription: ${s.error}`
        : 'Not logged into Nous Portal: run /login, then /subscription.',
      'warning'
    )
  }

  host.transcript.panel('Subscription', subscriptionText(s))
}

/** `/config [show|get <key>|set <key> <value>|path|check|…]`: `hermes config …`; bare is `show`. */
function config(host: RefusedHost, arg: string) {
  const argv = words(arg)

  return cliPanel(host, `/config${argv.length ? ` ${argv.join(' ')}` : ''}`, [
    'config',
    ...(argv.length ? argv : ['show'])
  ])
}

/**
 * `/worktree [list|prune [--dry-run]]`: `hermes worktree …` on the session's repo (cli.exec runs in
 * the gateway's folder, not the session's). `/worktree new` moves the classic CLI's own process into
 * a tree; nothing here can move a shared session.
 */
function worktree(host: RefusedHost, arg: string) {
  const [first = 'list', ...rest] = words(arg)
  const sub = first.toLowerCase()
  const cwd = host.session.info?.cwd

  if (sub === 'new') {
    return host.transcript.notice(
      '/worktree new runs only in the classic CLI. Start a session in a new worktree with `hermes -w` in a terminal.',
      'warning'
    )
  }

  const head = sub === 'status' || sub === 'show' ? 'list' : sub

  if (!['audit', 'list', 'ls', 'prune'].includes(head)) {
    return host.transcript.notice('Usage: /worktree [list|prune [--dry-run]]', 'warning')
  }

  if (!cwd) {
    return host.transcript.notice('Wait for the session to start: /worktree needs its folder.', 'warning')
  }

  return cliPanel(host, `/worktree ${[head, ...rest].join(' ')}`, ['worktree', head, ...rest, '--repo', cwd])
}

/**
 * `/snapshot create [label]`: `hermes backup --quick`, the same quick state snapshot. Listing,
 * restoring and pruning them have no `hermes` command, so only the classic CLI does those.
 */
function snapshot(host: RefusedHost, arg: string) {
  const [first = '', ...rest] = words(arg)

  if (first.toLowerCase() !== 'create') {
    return host.transcript.notice(
      '/snapshot list, restore and prune run only in the classic CLI (hermes --cli). Here, /snapshot create [label] takes one.',
      'warning'
    )
  }

  const label = rest.join(' ')

  return cliPanel(host, '/snapshot create', ['backup', '--quick', ...(label ? ['--label', label] : [])])
}

/** `/update`: `hermes update` in a split below the chat, as Ink hands the terminal to it on exit. */
async function update(host: RefusedHost) {
  if (await openHermesSplit(['update'], host.session.info?.cwd || process.env.HOME || '/')) {
    return host.transcript.notice(
      'Running `hermes update` in the split below. Hermes may restart the gateway when it finishes.'
    )
  }

  host.transcript.notice('Run `hermes update` in a terminal to update Hermes.')
}

/** Runs a command, reporting a gateway refusal as `/<name> failed: …`. */
const guarded =
  (name: string, run: RefusedCommand['run']): RefusedCommand['run'] =>
  async (host, arg) => {
    try {
      return await run(host, arg)
    } catch (e) {
      host.transcript.notice(`/${name} failed: ${errorText(e)}`, 'error')
    }
  }

const ROUTED: readonly RefusedCommand[] = [
  { name: 'cron', run: host => openBackground(host, { tab: 'cron' }) },
  { name: 'browser', run: browser },
  { name: 'plugins', run: plugins },
  { aliases: ['upgrade'], name: 'subscription', run: subscription },
  { name: 'config', run: config },
  { name: 'worktree', run: worktree },
  { aliases: ['snap'], name: 'snapshot', run: snapshot },
  { name: 'update', run: update }
]

const ink = (feature: string) => (name: string) => `/${name} is an Ink TUI feature; ${feature}`
const messaging = (name: string) => `/${name} is for messaging platforms (Telegram, Discord…).`
const classic = (instead: string) => (name: string) =>
  `/${name} runs only in the classic CLI (hermes --cli). ${instead}`

/** Commands this frontend never offers, each with the line that answers it when typed anyway. */
const HIDDEN: readonly { name: string; aliases?: readonly string[]; why: (name: string) => string }[] = [
  // Ink TUI display and input features.
  { name: 'battery', why: ink('Tern has no battery gauge.') },
  { name: 'density', why: ink('Tern has no compact mode.') },
  { aliases: ['detail'], name: 'details', why: ink('Tern has no detail levels.') },
  { name: 'focus', why: ink('Tern has no focus view.') },
  { name: 'indicator', why: ink('Tern has its own busy indicator.') },
  { aliases: ['learning', 'memory-graph'], name: 'journey', why: ink('Tern has no learning timeline.') },
  { name: 'logs', why: ink('Tern has no gateway log viewer.') },
  { aliases: ['scroll'], name: 'mouse', why: ink('Tern handles the mouse itself.') },
  { name: 'palette', why: ink('in Tern, type / to search every command.') },
  { name: 'pet', why: ink('Tern has no pet.') },
  { aliases: ['generate-pet'], name: 'hatch', why: ink('Tern has no pet.') },
  { aliases: ['compose'], name: 'prompt', why: ink("Tern's composer already edits Markdown.") },
  { name: 'redraw', why: ink('Tern repaints by itself.') },
  { aliases: ['sb'], name: 'statusbar', why: ink('Tern has no status bar to toggle.') },
  { aliases: ['ts'], name: 'timestamps', why: ink('Tern already shows the time of each prompt.') },
  { name: 'wake', why: ink('Tern has no wake word.') },
  // The messaging gateway's own.
  { name: 'pause', why: messaging },
  { name: 'platform', why: messaging },
  { name: 'restart', why: messaging },
  { aliases: ['set-home'], name: 'sethome', why: messaging },
  { name: 'start', why: messaging },
  { name: 'topic', why: messaging },
  { name: 'handoff', why: classic('It hands the session to a messaging platform.') },
  { name: 'export', why: classic('In a terminal, `hermes profile export` does the same.') },
  { name: 'import', why: classic('In a terminal, `hermes profile import <archive>` does the same.') }
]

/** Every hidden command's name and alias (lowercase). */
export const HIDDEN_COMMANDS: ReadonlySet<string> = new Set(HIDDEN.flatMap(h => [h.name, ...(h.aliases ?? [])]))

/** The commands this module answers: the routed ones, then a line for each hidden one. */
export const REFUSED_COMMANDS: readonly RefusedCommand[] = [
  ...ROUTED.map(c => ({ ...c, run: guarded(c.name, c.run) })),
  ...HIDDEN.map(h => ({
    aliases: h.aliases,
    name: h.name,
    run: (host: RefusedHost) => host.transcript.notice(h.why(h.name), 'warning')
  }))
]
