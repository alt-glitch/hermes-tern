import type { CompletionItem } from '@hermes/shared/gateway-events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { type CommandHost, HIDDEN_COMMANDS, localCommand } from '../commands.js'
import type { Overlay } from '../overlay.js'
import { openBackground } from '../overlays/background.js'
import { slashItems } from '../overlays/completion.js'
import { openHelp } from '../overlays/help.js'
import { subscriptionText } from '../refusedCommands.js'
import { resolveSlashName } from '../slashResolve.js'
import { openHermesSplit } from '../watch/spec.js'

vi.mock('../overlays/background.js', () => ({ openBackground: vi.fn() }))
vi.mock('../watch/spec.js', () => ({ openHermesSplit: vi.fn(async () => true) }))

/** The slice of the command host these commands reach; `reply` answers every request. */
function app(reply: (method: string, params: unknown) => unknown = () => null, cwd: string | null = '/repo') {
  const request = vi.fn(async (method: string, params?: unknown) => reply(method, params))

  return {
    gw: { request },
    request,
    session: { info: cwd ? { cwd } : null, ref: { live: 'sid-1', stored: null } },
    transcript: { notice: vi.fn(), panel: vi.fn() }
  }
}

type Fake = ReturnType<typeof app>

const run = (a: Fake, name: string, arg = '') => localCommand(name)!.run(a as unknown as CommandHost, arg)

beforeEach(() => vi.clearAllMocks())

describe('commands the shared gateway refuses, routed here', () => {
  it('/cron opens the Background sheet on its Cron tab', async () => {
    const a = app()

    await run(a, 'cron')
    expect(openBackground).toHaveBeenCalledWith(a, { tab: 'cron' })
    expect(a.request).not.toHaveBeenCalled()
  })

  it('/browser reads browser.manage status for this session', async () => {
    const a = app(() => ({ browser_use: true, connected: true, url: 'http://127.0.0.1:9222' }))

    await run(a, 'browser')
    expect(a.request).toHaveBeenCalledWith('browser.manage', { action: 'status', session_id: 'sid-1' })
    expect(a.transcript.notice).toHaveBeenCalledWith(
      'Browser connected: http://127.0.0.1:9222\nBrowser Use mode: browser_exec runs through the Browser Use CLI.',
      undefined
    )
  })

  it('/browser use off sends enabled: false and says it applies to new sessions', async () => {
    const a = app(() => ({ connected: false }))

    await run(a, 'browser', 'use off')
    expect(a.request).toHaveBeenCalledWith('browser.manage', { action: 'use', enabled: false, session_id: 'sid-1' })
    expect(a.transcript.notice.mock.calls[0]![0]).toMatch(/^Browser Use mode off.*New sessions get it/)
  })

  it("/browser connect shows the shared gateway's refusal, with the default CDP url sent", async () => {
    const refusal =
      '/browser connect and /browser disconnect would switch the browser for every chat on this shared gateway.'
    const a = app(() => {
      throw new Error(refusal)
    })

    await run(a, 'browser', 'connect')
    expect(a.request).toHaveBeenCalledWith('browser.manage', {
      action: 'connect',
      session_id: 'sid-1',
      url: 'http://127.0.0.1:9222'
    })
    expect(a.transcript.notice).toHaveBeenCalledWith(refusal, 'warning')
  })

  it('/browser answers an unknown action with its usage, sending nothing', async () => {
    const a = app()

    await run(a, 'browser', 'open')
    await run(a, 'browser', 'use maybe')
    expect(a.request).not.toHaveBeenCalled()
    expect(a.transcript.notice.mock.calls.map(c => c[0])).toEqual([
      'Usage: /browser [status|use [on|off]|connect [url]|disconnect]',
      'Usage: /browser use [on|off]'
    ])
  })

  it('/plugins lists the user plugins from plugins.manage, and /plugins all the bundled ones too', async () => {
    const plugins = [
      { description: 'Tern frontend', name: 'tern', source: 'user', status: 'enabled', version: '0.4.0' },
      { name: 'old', source: 'git', status: 'disabled' },
      { name: 'memory-honcho', source: 'bundled', status: 'not enabled' }
    ]
    const a = app(() => ({ bundled_count: 1, plugins, user_count: 2 }))

    await run(a, 'plugins')
    expect(a.request).toHaveBeenCalledWith('plugins.manage', { action: 'list' })
    expect(a.transcript.panel).toHaveBeenLastCalledWith(
      'Plugins',
      '- ✓ **tern** (0.4.0, user) — Tern frontend\n- ✗ **old** (git)\n\n1 bundled plugin not shown: /plugins all lists them.'
    )

    await run(a, 'plugins', 'all')
    expect(a.transcript.panel.mock.lastCall![1]).toContain('- · **memory-honcho** (bundled, not enabled)')
  })

  it('/plugins enable is a usage notice: Ink sends it to slash.exec, which the shared gateway refuses', async () => {
    const a = app()

    await run(a, 'plugins', 'enable foo')
    expect(a.request).not.toHaveBeenCalled()
    expect(a.transcript.notice).toHaveBeenCalledWith(
      'Usage: /plugins [list|all]. To enable a plugin, run `hermes plugins enable …` in a terminal.',
      'warning'
    )
  })

  it('/subscription (and /upgrade) shows the plan from subscription.state with a link to change it', async () => {
    const state = {
      can_change_plan: true,
      current: { credits_remaining: '12.50', monthly_credits: '20', tier_name: 'Plus' },
      logged_in: true,
      org_id: 'org-1',
      org_name: 'Nous',
      portal_url: 'https://portal.nousresearch.com/billing',
      role: 'admin',
      tiers: [{ dollars_per_month_display: '$20', is_current: true }],
      usage: { available: true, renews_display: 'Nov 1' }
    }
    const a = app(() => state)

    await run(a, 'upgrade')
    expect(a.request).toHaveBeenCalledWith('subscription.state', {})
    expect(a.transcript.panel).toHaveBeenCalledWith(
      'Subscription',
      [
        '**Plan:** Plus ($20 / month)',
        '**Credits:** 12.50 of 20 left this cycle',
        '**Renews:** Nov 1',
        '**Account:** Nous (admin)',
        '',
        '[Change your plan](https://portal.nousresearch.com/manage-subscription?org_id=org-1) on the Nous Portal.'
      ].join('\n')
    )
  })

  it('/subscription says what is pending, and who may change the plan', () => {
    const text = subscriptionText({
      can_change_plan: false,
      current: {
        cancel_at_period_end: true,
        pending_downgrade_display: 'on Nov 1',
        pending_downgrade_tier_name: 'Basic',
        tier_name: 'Plus'
      }
    })

    expect(text).toContain('Changes to Basic on Nov 1.')
    expect(text).toContain('Cancels at the end of the cycle.')
    expect(text).toContain('Only an admin of this account can change the plan.')
  })

  it('/subscription logged out says how to log in', async () => {
    const a = app(() => ({ logged_in: false }))

    await run(a, 'subscription')
    expect(a.transcript.panel).not.toHaveBeenCalled()
    expect(a.transcript.notice).toHaveBeenCalledWith(
      'Not logged into Nous Portal: run /login, then /subscription.',
      'warning'
    )
  })

  it('/config runs `hermes config show` through cli.exec, and passes its subcommands', async () => {
    const a = app(() => ({ blocked: false, code: 0, output: 'Model: hermes-4\n' }))

    await run(a, 'config')
    expect(a.request).toHaveBeenCalledWith('cli.exec', { argv: ['config', 'show'] })
    expect(a.transcript.panel).toHaveBeenCalledWith('/config', 'Model: hermes-4')

    await run(a, 'config', 'get model.default')
    expect(a.request).toHaveBeenLastCalledWith('cli.exec', { argv: ['config', 'get', 'model.default'] })
    expect(a.transcript.panel).toHaveBeenLastCalledWith('/config get model.default', 'Model: hermes-4')
  })

  it("/config edit shows cli.exec's hint, and a failing command its exit code", async () => {
    const blocked = app(() => ({
      blocked: true,
      code: -1,
      hint: '`hermes config edit` needs $EDITOR in a real terminal',
      output: ''
    }))

    await run(blocked, 'config', 'edit')
    expect(blocked.transcript.panel).not.toHaveBeenCalled()
    expect(blocked.transcript.notice).toHaveBeenCalledWith(
      '`hermes config edit` needs $EDITOR in a real terminal',
      'warning'
    )

    const failed = app(() => ({ blocked: false, code: 2, output: 'unknown key' }))

    await run(failed, 'config', 'get nope')
    expect(failed.transcript.panel).toHaveBeenCalledWith('/config get nope', 'unknown key')
    expect(failed.transcript.notice).toHaveBeenCalledWith('`hermes config get nope` exited with code 2.', 'warning')
  })

  it("/worktree runs `hermes worktree` on the session's repo", async () => {
    const a = app(() => ({ blocked: false, code: 0, output: 'main  keep' }))

    await run(a, 'worktree')
    expect(a.request).toHaveBeenCalledWith('cli.exec', { argv: ['worktree', 'list', '--repo', '/repo'] })
    expect(a.transcript.panel).toHaveBeenCalledWith('/worktree list', 'main  keep')

    await run(a, 'worktree', 'prune --dry-run')
    expect(a.request).toHaveBeenLastCalledWith('cli.exec', {
      argv: ['worktree', 'prune', '--dry-run', '--repo', '/repo']
    })
  })

  it('/worktree new, or with no session folder, sends nothing', async () => {
    const a = app()

    await run(a, 'worktree', 'new feature')
    expect(a.transcript.notice.mock.lastCall![0]).toMatch(/^\/worktree new runs only in the classic CLI/)

    const early = app(() => null, null)

    await run(early, 'worktree', 'list')
    expect(early.transcript.notice).toHaveBeenCalledWith(
      'Wait for the session to start: /worktree needs its folder.',
      'warning'
    )
    expect([...a.request.mock.calls, ...early.request.mock.calls]).toEqual([])
  })

  it('/snapshot create (and /snap create) runs `hermes backup --quick`; the other forms are classic-CLI only', async () => {
    const a = app(() => ({ blocked: false, code: 0, output: 'Snapshot created: 20261018-1' }))

    await run(a, 'snap', 'create before upgrade')
    expect(a.request).toHaveBeenCalledWith('cli.exec', { argv: ['backup', '--quick', '--label', 'before upgrade'] })
    expect(a.transcript.panel).toHaveBeenCalledWith('/snapshot create', 'Snapshot created: 20261018-1')

    await run(a, 'snapshot', 'restore 1')
    expect(a.request).toHaveBeenCalledTimes(1)
    expect(a.transcript.notice.mock.lastCall![0]).toMatch(
      /^\/snapshot list, restore and prune run only in the classic CLI/
    )
  })

  it('/update opens a split running `hermes update`, else tells the user to run it', async () => {
    const a = app()

    await run(a, 'update')
    expect(openHermesSplit).toHaveBeenCalledWith(['update'], '/repo')
    expect(a.transcript.notice.mock.lastCall![0]).toMatch(/^Running `hermes update` in the split below/)

    vi.mocked(openHermesSplit).mockResolvedValueOnce(false)
    await run(a, 'update')
    expect(a.transcript.notice).toHaveBeenLastCalledWith('Run `hermes update` in a terminal to update Hermes.')
  })

  it('reports a failed RPC as `/<name> failed: …`', async () => {
    const a = app(() => {
      throw new Error('boom')
    })

    await run(a, 'plugins')
    expect(a.transcript.notice).toHaveBeenCalledWith('/plugins failed: boom', 'error')
  })
})

/** Every registry command `slash.exec` refuses that no other local command routes. */
const REFUSED = [
  'battery',
  'browser',
  'config',
  'cron',
  'export',
  'focus',
  'handoff',
  'hatch',
  'import',
  'indicator',
  'journey',
  'palette',
  'pause',
  'pet',
  'platform',
  'plugins',
  'prompt',
  'redraw',
  'restart',
  'sethome',
  'snapshot',
  'start',
  'statusbar',
  'subscription',
  'timestamps',
  'topic',
  'update',
  'wake',
  'worktree'
]

describe('hidden commands', () => {
  it('leaves none of the 29 refused commands to the generic refusal', () => {
    expect(REFUSED.filter(name => !localCommand(name))).toEqual([])
  })

  it('answers a typed Ink-only or messaging-only command, or its alias, in one line', async () => {
    const a = app()

    await run(a, 'pet')
    await run(a, 'set-home')
    await run(a, 'sb')
    await run(a, 'export')
    expect(a.request).not.toHaveBeenCalled()
    expect(a.transcript.notice.mock.calls).toEqual([
      ['/pet is an Ink TUI feature; Tern has no pet.', 'warning'],
      ['/sethome is for messaging platforms (Telegram, Discord…).', 'warning'],
      ['/statusbar is an Ink TUI feature; Tern has no status bar to toggle.', 'warning'],
      [
        '/export runs only in the classic CLI (hermes --cli). In a terminal, `hermes profile export` does the same.',
        'warning'
      ]
    ])
  })

  it('hides them, aliases too, and none of the routed ones', () => {
    for (const name of ['pet', 'hatch', 'generate-pet', 'sethome', 'set-home', 'restart', 'compose', 'ts', 'mouse']) {
      expect(HIDDEN_COMMANDS.has(name)).toBe(true)
    }

    for (const name of ['cron', 'browser', 'plugins', 'subscription', 'config', 'worktree', 'snapshot', 'update']) {
      expect(HIDDEN_COMMANDS.has(name)).toBe(false)
    }
  })

  const row = (text: string): CompletionItem => ({ display: text, kind: 'command', meta: '', text })

  it('drops them from completion', () => {
    const items = slashItems([row('/pet'), row('/personality'), row('/pause'), row('/platform'), row('/plugins')], '/p')

    expect(items.map(i => i.text)).toEqual(['/personality', '/plugins', '/ps', '/prs'])
  })

  it('never resolves a prefix to one', () => {
    const catalog = {
      canon: { '/pet': '/pet', '/personality': '/personality', '/sethome': '/sethome', '/set-home': '/sethome' }
    }

    expect(resolveSlashName('pe', catalog)).toEqual({ name: 'personality' })
    expect(resolveSlashName('seth', catalog)).toBeNull()
  })

  it('drops them from /help', async () => {
    let sheet: Overlay | undefined
    const categories = [
      {
        name: 'Session',
        pairs: [
          ['/sethome', 'Set this chat as the home channel'],
          ['/cron', 'Manage scheduled tasks'],
          ['/pet', 'Toggle a pet']
        ]
      }
    ]
    const help = {
      gw: { request: async () => ({ categories }) },
      open: (o: Overlay) => (sheet = o),
      session: { info: null, ref: { live: 's1', stored: null } },
      transcript: { notice: vi.fn() }
    }

    await openHelp(help as never)
    const text = JSON.stringify(sheet!.node('layer.help'))

    expect(text).toContain('/cron')
    expect(text).not.toContain('/sethome')
    expect(text).not.toContain('/pet')
  })
})
