// The gateway connection: `hermes gateway attach --json` per dial (hermes/connect.ts), and the
// skin colors tern derives itself (hermes/theme.ts).

import { describe, expect, it } from 'vitest'

import { AttachError, attachGateway, type Ran, readHermesCommand, terminalAttachFailure } from '../hermes/connect.js'
import { skinColors } from '../hermes/theme.js'

const HERMES = { argv: ['/py', '-m', 'hermes_cli.main'] as const, env: { PYTHONPATH: '/src' } }

const GRANT = {
  endpoint: { instance_id: 'inst-1', profile_id: 'default' },
  protocol: 'hermes-gateway-v1',
  protocols: ['hermes-gateway-v1', 'hermes-gateway-ticket.t1'],
  reason_code: null,
  state: 'ready',
  ticket: 't1',
  url: 'ws://127.0.0.1:9000/api/ws'
}

/** A runner answering with `ran`; records each command and its environment. */
function runner(ran: Partial<Ran>) {
  const calls: { file: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = []

  return {
    calls,
    run: async (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => (calls.push({ args, env, file }), { code: 0, stderr: '', stdout: '', ...ran })
  }
}

describe('attachGateway', () => {
  it('runs attach with --start first and --recover when asked, and maps the grant', async () => {
    const r = runner({ stdout: `${JSON.stringify(GRANT)}\n` })
    const connect = attachGateway(HERMES, r.run, { HOME: '/me', PYTHONPATH: '/old' })

    expect(await connect(true, false)).toEqual({ instance_id: 'inst-1', profile_id: 'default', protocols: GRANT.protocols, url: GRANT.url })
    await connect(false, true)
    await connect(false, false)
    expect(r.calls.map(c => [c.file, ...c.args].join(' '))).toEqual([
      '/py -m hermes_cli.main gateway attach --json --start',
      '/py -m hermes_cli.main gateway attach --json --recover',
      '/py -m hermes_cli.main gateway attach --json'
    ])
    expect(r.calls[0]?.env).toMatchObject({ HOME: '/me', PYTHONPATH: '/src' })
  })

  it("throws attach's own verdict, terminal only for what no retry fixes", async () => {
    const verdict = { message: 'gateway incompatible: runtime_protocol\ngateway incompatible: run hermes update', state: 'incompatible' }
    const incompatible = attachGateway(HERMES, runner({ code: 3, stdout: JSON.stringify(verdict) }).run)
    const error = await incompatible(true, false).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AttachError)
    expect(terminalAttachFailure(error instanceof Error ? error : new Error())).toBe('gateway incompatible: runtime_protocol')

    const draining = attachGateway(HERMES, runner({ code: 6, stdout: JSON.stringify({ message: 'gateway draining: restart_wait' }) }).run)
    const busy = await draining(false, false).catch((e: unknown) => e)
    expect(busy instanceof Error && busy.message).toBe('gateway draining: restart_wait')
    expect(terminalAttachFailure(busy instanceof Error ? busy : new Error())).toBeUndefined()
  })

  it('names an older Hermes without the attach command, and a reply it cannot read', async () => {
    const old = attachGateway(HERMES, runner({ code: 2, stderr: "hermes gateway: 'attach' is not a `hermes gateway` command." }).run)
    await expect(old(true, false)).rejects.toThrow('this Hermes has no `hermes gateway attach`; run `hermes update`')

    const garbled = attachGateway(HERMES, runner({ stdout: 'not json' }).run)
    await expect(garbled(true, false)).rejects.toThrow('hermes gateway attach exited 0')
  })
})

describe('readHermesCommand', () => {
  it('reads the launcher command, and nothing from a missing or broken one', () => {
    expect(readHermesCommand(JSON.stringify(HERMES))).toEqual({ argv: ['/py', '-m', 'hermes_cli.main'], env: { PYTHONPATH: '/src' } })
    expect(readHermesCommand('{"argv":["/py"]}')).toEqual({ argv: ['/py'], env: {} })
    expect(readHermesCommand(undefined)).toBeUndefined()
    expect(readHermesCommand('{"argv":[]}')).toBeUndefined()
    expect(readHermesCommand('nope')).toBeUndefined()
  })
})

describe('skinColors', () => {
  it("takes the skin's tokens, else Hermes' default seeds for the polarity", () => {
    expect(skinColors({}, 'dark')).toEqual({ accent: '#FFBF00', error: '#ef5350', ok: '#4caf50', warn: '#ffa726' })
    expect(skinColors({ banner_accent: '#3366ff', ui_ok: '#00aa00' }, 'dark')).toMatchObject({ accent: '#3366ff', ok: '#00aa00' })
    expect(skinColors({ ui_accent: '#112233', banner_accent: '#3366ff' }, 'light').accent).not.toBe('#3366ff')
  })

  it('lifts a color that would not read on the background', () => {
    const lifted = skinColors({ ui_error: '#120000' }, 'dark').error

    expect(lifted).not.toBe('#120000')
  })
})
