// Bridge the existing live-voice lease/UI to hermes-talk's owned terminal call.
// Canonical gateways do not expose the donor voice.live.* RPCs.
import { EventEmitter } from 'node:events'
import type { GatewayClient } from '@tui/gatewayClient.js'
import { record } from '../wire/json.js'

const PHASES = new Set(['idle', 'starting', 'listening', 'thinking', 'speaking', 'stopping', 'error'])
interface Snapshot { live_id: string; phase: string; active: boolean; error: string }
interface Owner { sid: string; id: string }

function snapshot(value: unknown, id: string): Snapshot {
  const result = record(value)
  if (!result || typeof result['output'] !== 'string') throw new Error('Hermes Talk returned no control receipt')
  const p = record(result['output'])
  if (!p || p['live_id'] !== id || typeof p['phase'] !== 'string' || !PHASES.has(p['phase']) ||
      typeof p['active'] !== 'boolean' || typeof p['error'] !== 'string') throw new Error('Invalid Hermes Talk call identity or state')
  return { live_id: id, phase: p['phase'], active: p['active'], error: p['error'] }
}

/** Heartbeats only while a call exists; missing client heartbeats end the backend call. */
export class TalkGateway extends EventEmitter {
  readonly #gw: Pick<GatewayClient, 'request' | 'on' | 'off'>
  #owner: Owner | undefined
  #timer: NodeJS.Timeout | undefined
  #polling = false
  readonly #exit = () => { this.#clear(); this.emit('exit') }

  constructor(gw: Pick<GatewayClient, 'request' | 'on' | 'off'>) {
    super()
    this.#gw = gw
    gw.on('exit', this.#exit)
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const sid = params['session_id'], id = params['live_id']
    if (typeof sid !== 'string' || typeof id !== 'string') throw new Error('Voice needs a session and call identity')
    if (method === 'voice.live.start') {
      if (this.#owner) throw new Error('A voice call is already starting or active')
      const owner = { sid, id }
      this.#owner = owner
      try {
        const receipt = await this.#command(owner, 'start')
        this.#publish(owner, receipt)
        if (this.#owner === owner) this.#schedule()
        return receipt
      } catch (error) {
        if (this.#owner === owner) this.#clear()
        throw error
      }
    }
    if (method !== 'voice.live.control') throw new Error('Unsupported Talk adapter method')
    const owner = this.#owner
    if (!owner || owner.sid !== sid || owner.id !== id) throw new Error('Voice call no longer belongs to this session')
    if (params['action'] !== 'stop') throw new Error('This Hermes Talk adapter supports Stop; provider-native barge-in stays active')
    const receipt = await this.#command(owner, 'stop')
    this.#publish(owner, receipt)
    return receipt
  }

  async #command(owner: Owner, action: 'start' | 'status' | 'stop'): Promise<Snapshot> {
    const result = await this.#gw.request('command.dispatch', {
      session_id: owner.sid, name: 'tern-talk', arg: `${action} ${owner.id}`
    })
    return snapshot(result, owner.id)
  }

  #publish(owner: Owner, receipt: Snapshot) {
    if (this.#owner !== owner) return
    if (receipt.error) this.#event(owner, 'error', receipt.error)
    this.#event(owner, receipt.active ? receipt.phase : 'idle')
    if (!receipt.active) this.#clear()
  }

  #event(owner: Owner, phase: string, error = '') {
    this.emit('event', { type: 'voice.live', session_id: owner.sid,
      payload: { live_id: owner.id, phase, ...(error ? { error } : {}) } })
  }

  #schedule() {
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => void this.#poll(), 350)
    this.#timer.unref()
  }

  async #poll() {
    const owner = this.#owner
    if (!owner || this.#polling) return
    this.#polling = true
    try {
      this.#publish(owner, await this.#command(owner, 'status'))
    } catch {
      if (this.#owner === owner) this.#event(owner, 'error', 'Voice control disconnected. Backend releases audio after its heartbeat expires; Stop can retry.')
    } finally {
      this.#polling = false
      if (this.#owner === owner) this.#schedule()
    }
  }

  #clear() {
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#owner = undefined
  }

  dispose() {
    const owner = this.#owner
    this.#clear()
    this.#gw.off('exit', this.#exit)
    if (owner) void this.#command(owner, 'stop').catch(() => undefined)
  }
}
