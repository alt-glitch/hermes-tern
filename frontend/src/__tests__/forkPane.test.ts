import { describe, expect, it, vi } from 'vitest'

import { type CommandHost, localCommand } from '../commands/local.js'
import type { SessionHost } from '../commands/session.js'
import { liveSessionId } from '../core/ids.js'
import { type KeyCx, KEYS, matches, onKey } from '../draft/keys.js'
import { type ForkHost, forkSession, shellQuote } from '../fork-session.js'
import { launchPane } from '../pane-launcher.js'
import { isUnsupportedFork } from '../wire/fork.js'

import { key, must, stub, stubOverlay } from './fakes.js'

function fixture(options: { fallback?: boolean; profile?: string } = {}) {
  const requests: { method: string; params: Record<string, unknown> }[] = []
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    requests.push({ method, params })

    switch (method) {
      case 'session.fork':
        if (options.fallback) {
          throw new Error('Method not found: session.fork')
        }

        return { session_id: 'stored-child', profile: options.profile ?? 'owning-profile' }

      case 'session.resume':
        return { execution_generation: 7, revision: 12 }

      case 'session.mutate':
        return { branched_session_id: 'compat-child' }

      default:
        throw new Error('unexpected test RPC ' + method)
    }
  })
  let current = 'runtime-parent'
  const gw = stub<SessionHost['gw']>({ request })
  const control = stub<SessionHost>({
    busy: false,
    gw,
    sid: liveSessionId('runtime-parent'),
    stale: () => current !== 'runtime-parent'
  })
  const notices: { text: string; tone: string | undefined }[] = []
  const host = stub<ForkHost>({
    busy: null,
    control: () => control,
    notice: (text: string, tone?: string) => void notices.push({ text, tone }),
    session: { info: { cwd: '/workspace', profile_name: 'owning-profile' } }
  })
  const open = vi.fn(async (_argv: readonly string[], _cwd: string) => true)

  return { control, host, notices, open, request, requests, switchAway: () => { current = 'other' } }
}

const fork = (f: ReturnType<typeof fixture>, arg = '') => forkSession(f.host, arg, f.open)

describe('fork session in a sibling pane', () => {
  it('registers /fork separately from /branch (which still switches the shown view)', () => {
    expect(must(localCommand('fork')).name).toBe('fork')
    expect(must(localCommand('branch')).name).toBe('branch')
    expect(must(localCommand('fork')).help).toContain('Tern pane')
  })

  it('calls the durable RPC before launching; resume/profile are exact arguments and original is untouched', async () => {
    const f = fixture()
    const snapshot = f.host.session
    await fork(f)

    expect(f.requests).toEqual([{ method: 'session.fork', params: { session_id: 'runtime-parent' } }])
    expect(f.open).toHaveBeenCalledExactlyOnceWith(['tern', '--resume', 'stored-child', '-p', 'owning-profile'], '/workspace')
    expect(f.host.session).toBe(snapshot)
    expect(f.control.sid).toBe('runtime-parent')
    expect(f.notices.map(n => n.text)).toEqual([
      'Forked session stored-child. Resume with: hermes tern --resume stored-child -p owning-profile',
      'Opened fork stored-child in a new Tern pane.'
    ])
  })

  it('an explicit durable row is forwarded exactly, never an ordinal or transcript text', async () => {
    const f = fixture()
    await fork(f, '123')
    expect(f.requests).toEqual([{
      method: 'session.fork',
      params: { session_id: 'runtime-parent', target_message_id: 123 }
    }])
  })

  it.each(['0', '-1', '1.5', '1e3', '123 extra', '9007199254740992'])('invalid target %s sends no RPC', async arg => {
    const f = fixture()
    await fork(f, arg)
    expect(f.requests).toEqual([])
    expect(f.open).not.toHaveBeenCalled()
    expect(f.notices[0]?.text).toContain('Usage: /fork')
  })

  it('an old gateway forks via a CAS-fenced compatibility branch, never adopts it', async () => {
    const f = fixture({ fallback: true })
    await fork(f)
    expect(f.requests.map(c => c.method)).toEqual(['session.fork', 'session.resume', 'session.mutate'])
    expect(f.requests[2]?.params).toMatchObject({
      expected_generation: 7, expected_revision: 12, operation: 'branch', payload: {}, session_id: 'runtime-parent'
    })
    expect(f.open).toHaveBeenCalledExactlyOnceWith(['tern', '--resume', 'compat-child', '-p', 'owning-profile'], '/workspace')
    expect(f.notices.some(n => n.text.includes('may omit tool-history details'))).toBe(true)
    expect(f.control.sid).toBe('runtime-parent')
  })

  it('targeted fork on an older gateway fails closed instead of copying all history', async () => {
    const f = fixture({ fallback: true })
    await fork(f, '5')
    expect(f.requests.map(c => c.method)).toEqual(['session.fork'])
    expect(f.open).not.toHaveBeenCalled()
    expect(f.notices[0]?.text).toContain('Method not found')
  })

  it('fails clearly without a session or during an active turn', async () => {
    const local = fixture()
    const sessionless = stub<ForkHost>({ ...local.host, control: () => ({ ...local.control, sid: null }) })
    await forkSession(sessionless, '', local.open)
    expect(local.requests).toEqual([])
    expect(local.open).not.toHaveBeenCalled()
    expect(local.notices[0]?.text).toBe('Start a session before forking.')
    const running = fixture()
    const busy = stub<ForkHost>({ ...running.host, busy: { label: 'Working' } })
    await forkSession(busy, '', running.open)
    expect(running.requests).toEqual([])
    expect(running.notices[0]?.text).toContain('Wait for the current turn')
  })

  it.each(['session_owner_mismatch', 'permission_denied'])('a gateway %s refusal cannot fall back or launch a fork', async reason => {
    const f = fixture()
    f.request.mockRejectedValueOnce(new Error(reason))

    await fork(f)

    expect(f.request).toHaveBeenCalledExactlyOnceWith('session.fork', { session_id: 'runtime-parent' })
    expect(f.open).not.toHaveBeenCalled()
    expect(f.notices).toEqual([{ text: 'Could not fork session: ' + reason, tone: 'error' }])
    expect(f.control.sid).toBe('runtime-parent')
  })

  it('an unavailable compatibility mutation cannot claim a saved child or open a pane', async () => {
    const f = fixture({ fallback: true })
    f.request.mockImplementation(async method => {
      if (method === 'session.fork') throw new Error('Method not found: session.fork')
      if (method === 'session.resume') return { revision: 12, execution_generation: 7 }
      throw new Error('Method not found: session.mutate')
    })

    await fork(f)

    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['session.fork', 'session.resume', 'session.mutate'])
    expect(f.open).not.toHaveBeenCalled()
    expect(f.notices).toEqual([{ text: 'Could not fork session: Method not found: session.mutate', tone: 'error' }])
    expect(f.control.sid).toBe('runtime-parent')
  })

  it('repeats cannot create two children while the first request remains pending', async () => {
    const f = fixture()
    const deferred = Promise.withResolvers<unknown>()
    f.request.mockImplementation(async () => deferred.promise)
    const first = fork(f)
    await fork(f)
    expect(f.request).toHaveBeenCalledTimes(1)
    deferred.resolve({ session_id: 'one-child', profile: 'main' })
    await first
    expect(f.open).toHaveBeenCalledTimes(1)
  })

  it('a replaced original does not launch its saved child, but still gives the recovery hint', async () => {
    const f = fixture()
    const deferred = Promise.withResolvers<unknown>()
    f.request.mockImplementation(async () => deferred.promise)
    const first = fork(f)
    f.switchAway()
    deferred.resolve({ session_id: 'saved', profile: 'main' })
    await first
    expect(f.open).not.toHaveBeenCalled()
    expect(f.notices[0]?.text).toContain('hermes tern --resume saved -p main')
  })

  it('a failed split keeps the saved fork and a safely quoted recovery command', async () => {
    const f = fixture({ profile: "profile ; $(not-run) ' here" })
    f.open.mockRejectedValueOnce(new Error('fake split failure'))
    await fork(f)
    expect(f.open).toHaveBeenCalledTimes(1)
    expect(f.notices[0]?.text).toContain('Forked session stored-child')
    expect(f.notices.at(-1)?.text).toContain('Fork saved, but the Tern pane could not open: fake split failure')
    expect(shellQuote("x ' $(echo hi)")).toBe("'x '\\'' $(echo hi)'")
  })

  it('gateway failures or malformed receipts cannot claim a fork or open a pane', async () => {
    const f = fixture()
    f.request.mockRejectedValueOnce(new Error('database unavailable'))
    await fork(f)
    expect(f.open).not.toHaveBeenCalled()
    expect(f.notices[0]?.text).toContain('database unavailable')

    const invalid = fixture()
    invalid.request.mockResolvedValueOnce({ session_id: 'child', profile: '' })
    await fork(invalid)
    expect(invalid.open).not.toHaveBeenCalled()
    expect(invalid.notices[0]?.text).toContain('did not return a saved child')
  })

  it('fork syntax is reachable through the same local command dispatcher as the rest of the plugin', async () => {
    const f = fixture()
    const command = must(localCommand('fork'))
    const local = stub<CommandHost>(f.host)
    // Without Tern's launch environment, the real launcher cannot spawn an outside process.
    const previous = process.env['TERN_PANE']
    process.env['TERN_PANE'] = ''
    try {
      await command.run(local, '')
    } finally {
      if (previous === undefined) {
        delete process.env['TERN_PANE']
      } else {
        process.env['TERN_PANE'] = previous
      }
    }
    expect(f.requests.map(r => r.method)).toEqual(['session.fork'])
  })
})

describe('the fork shortcut', () => {
  it('Alt+Shift+F forks once, but cannot bypass a modal prompt; Alt+F remains word navigation', () => {
    const called = vi.fn()
    const ctx = stub<KeyCx>({
      completion: { onKey: () => false },
      dictation: { cancel: () => false, onKey: () => false },
      fork: called,
      liveVoice: { blocked: false },
      hud: () => false
    })
    const shortcut = key('f', { alt: true, shift: true })

    expect(matches(shortcut, KEYS.fork)).toBe(true)
    expect(matches(key('f', { alt: true }), KEYS.fork)).toBe(false)

    onKey(shortcut, ctx, undefined)
    expect(called).toHaveBeenCalledTimes(1)

    onKey(shortcut, ctx, stubOverlay('prompt:approval', { modal: true }))
    expect(called).toHaveBeenCalledTimes(1)
  })
})

describe('the actual plugin pane launcher', () => {
  const env = {
    HERMES_HOME: '/home',
    HERMES_TERN_HERMES: JSON.stringify({ argv: ['/venv/python', '-m', 'hermes_cli.main'], env: { PYTHONPATH: '/src' } }),
    TERN_PANE: 'b3'
  }

  it('uses fixed Tern argv, the plugin CLI and the active cwd without a shell', async () => {
    const execute = vi.fn(async (_file: string, _args: string[], _options: { shell: false }) => undefined)
    const argv = ['tern', '--resume', 'stored-child', '-p', 'profile ; $(not-run)']
    expect(await launchPane(argv, '/repo', env, execute)).toBe(true)
    expect(execute).toHaveBeenCalledExactlyOnceWith('tern', [
      'split', 'b3', 'right', '--cwd', '/repo', '--',
      'env', 'PYTHONPATH=/src', 'HERMES_HOME=/home', '/venv/python', '-m', 'hermes_cli.main', ...argv
    ], { shell: false })
  })

  it('without the launcher command or pane never runs a process', async () => {
    const execute = vi.fn(async (_file: string, _args: string[], _options: { shell: false }) => undefined)
    expect(await launchPane(['tern', '--resume', 'child'], '/repo', { ...env, TERN_PANE: undefined }, execute)).toBe(false)
    expect(await launchPane(['tern', '--resume', 'child'], '/repo', { ...env, HERMES_TERN_HERMES: undefined }, execute)).toBe(false)
    for (const command of ['', 'not-json', '{}', JSON.stringify({ argv: [], env: { PYTHONPATH: '/src' } })]) {
      expect(await launchPane(['tern', '--resume', 'child'], '/repo', { ...env, HERMES_TERN_HERMES: command }, execute)).toBe(false)
    }
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('wire compatibility', () => {
  it('accepts only a missing-method response for untargeted fallback', () => {
    expect(isUnsupportedFork({ code: -32601 })).toBe(true)
    expect(isUnsupportedFork(new Error('Unknown method: session.fork'))).toBe(true)
    expect(isUnsupportedFork(new Error('session_busy'))).toBe(false)
  })
})
