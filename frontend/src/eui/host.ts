// Ephemeral, instance-owned publications. Only trusted host code can register an operation.
// Model fences and the kit sandbox cannot create or look up these grants.
import type { Ticket } from '../core/epoch.js'
import type { EntryId } from '../core/ids.js'
import type { PanelEntry } from '../model.js'
import { decodeEuiHostCard, type EuiHostCardData } from '../wire/euiHostCard.js'

import type { EuiCardView } from './cards.js'
import { HOST_APPROVE_ID, hostSnapshot, type HostCardStatus } from './hostSnapshot.js'

export const MAX_HOST_CARDS = 48

export interface EuiHostOwner extends Ticket {
  readonly sessionId: string
}

export interface EuiHostPort {
  /** A permanent session/profile generation plus transcript lifetime, never a reusable id alone. */
  owner(): EuiHostOwner | undefined
  /** The pane is visible, connected and not switching sessions or covered by a modal. */
  active(): boolean
  append(title: string): PanelEntry
  contains(entry: PanelEntry): boolean
}

export interface EuiApprovalContext {
  readonly sessionId: string
  readonly revision: number
  readonly data: EuiHostCardData
  /** Aborts on replacement, eviction, owner loss or disposal; async operations must honor it. */
  readonly signal: AbortSignal
}
export type EuiOperation = (context: EuiApprovalContext) => void | Promise<void>

export interface EuiHostHandle {
  readonly id: EntryId
  readonly revision: number
  /** Publishes a new immutable revision and invalidates the previous revision's button. */
  update(data: unknown, operation?: EuiOperation): void
  revoke(): void
}

interface Slot {
  readonly entry: PanelEntry
  readonly key: string
  readonly revision: number
  readonly data: EuiHostCardData
  readonly owner: EuiHostOwner
  readonly controller: AbortController
  readonly onAbort: () => void
  operation: EuiOperation | undefined
  status: HostCardStatus
}

export class EuiHostCards {
  readonly #slots = new Map<PanelEntry, Slot>()
  readonly #kinds: readonly string[]
  readonly #changed: (key: string) => void
  readonly #port: EuiHostPort | undefined
  #revision = 0
  #closed = false
  #revoking = false

  constructor(kinds: readonly string[], changed: (key: string) => void, port?: EuiHostPort) {
    this.#kinds = kinds
    this.#changed = changed
    this.#port = port
  }

  get size(): number { return this.#slots.size }

  publish(raw: unknown, operation?: EuiOperation): EuiHostHandle {
    const data = this.#data(raw, operation)
    const port = this.#port
    const owner = port?.owner()
    if (this.#closed || this.#revoking || !port || !owner || !owner.sessionId ||
      owner.signal.aborted || !owner.isCurrent() || !port.active()) {
      throw new Error('Host card needs an active session')
    }
    this.sync()
    if (owner.signal.aborted || !owner.isCurrent() || !port.active()) {
      throw new Error('Host card owner changed')
    }
    const entry = port.append(data.title)
    if (this.#closed || owner.signal.aborted || !owner.isCurrent() || !port.contains(entry) || !port.active()) {
      throw new Error('Host card owner changed while publishing')
    }
    let slot = this.#install(entry, data, operation, owner)
    while (this.#slots.size > MAX_HOST_CARDS) {
      const oldest = this.#slots.values().next().value
      if (!oldest) break
      this.#drop(oldest)
      this.#changed(oldest.key)
    }
    this.#changed(slot.key)
    return {
      id: entry.id,
      get revision() { return slot.revision },
      update: (next, run) => {
        const data = this.#data(next, run)
        if (!this.#current(slot) || !port.active() || this.#revoking) {
          throw new Error('Host card is no longer current')
        }
        const owner = slot.owner
        this.#drop(slot)
        // An operation's abort handler may have changed the owning session synchronously.
        if (this.#closed || !owner.isCurrent() || owner.signal.aborted || !port.contains(entry) || !port.active()) {
          this.#changed(slot.key)
          throw new Error('Host card owner changed')
        }
        entry.title = data.title
        slot = this.#install(entry, data, run, owner)
        this.#changed(slot.key)
      },
      revoke: () => {
        if (this.#slots.get(entry) === slot) {
          this.#drop(slot)
          this.#changed(slot.key)
        }
      }
    }
  }

  /** Object identity is the authority: a matching model fence or reconstructed panel grants nothing. */
  view(entry: PanelEntry): EuiCardView | undefined {
    this.sync()
    const slot = this.#slots.get(entry)
    if (!slot) return undefined
    return {
      spec: slot.data,
      app: slot.data.app,
      label: slot.data.title,
      identity: 'host-' + slot.revision,
      node: hostSnapshot(slot.data, slot.status),
      activate: id => { this.#approve(slot, id) }
    }
  }

  /** Also covers transcript reset/load when the runtime id happens to stay the same. */
  sync() {
    for (const slot of this.#slots.values()) {
      if (!this.#current(slot)) {
        this.#drop(slot)
        this.#changed(slot.key)
      }
    }
  }

  invalidate() {
    const slots = [...this.#slots.values()]
    for (const slot of slots) this.#drop(slot)
    for (const slot of slots) this.#changed(slot.key)
  }

  close() {
    this.#closed = true
    this.invalidate()
  }

  #data(raw: unknown, operation: EuiOperation | undefined): EuiHostCardData {
    const data = decodeEuiHostCard(raw, this.#kinds)
    if (Boolean(data.approval) !== (typeof operation === 'function')) {
      throw new TypeError('An approval needs its separate host operation; read-only cards have none')
    }
    return data
  }

  #install(entry: PanelEntry, data: EuiHostCardData, operation: EuiOperation | undefined, owner: EuiHostOwner): Slot {
    const slot: Slot = {
      entry, key: 'main.' + entry.id + '.host', revision: ++this.#revision,
      data, operation, owner, controller: new AbortController(), status: 'pending',
      onAbort: () => {
        if (this.#slots.get(entry) === slot) {
          this.#drop(slot)
          this.#changed(slot.key)
        }
      }
    }
    this.#slots.set(entry, slot)
    owner.signal.addEventListener('abort', slot.onAbort, { once: true })
    return slot
  }

  #current(slot: Slot): boolean {
    return !this.#closed && this.#slots.get(slot.entry) === slot &&
      !slot.owner.signal.aborted && slot.owner.isCurrent() && this.#port?.contains(slot.entry) === true
  }

  #drop(slot: Slot) {
    this.#slots.delete(slot.entry)
    slot.operation = undefined
    slot.owner.signal.removeEventListener('abort', slot.onAbort)
    const wasRevoking = this.#revoking
    this.#revoking = true
    try { slot.controller.abort() } finally { this.#revoking = wasRevoking }
  }

  #approve(slot: Slot, id: number) {
    if (id !== HOST_APPROVE_ID || !this.#current(slot) || !this.#port?.active() ||
      slot.status !== 'pending' || !slot.operation) return
    const run = slot.operation
    // Consume before calling any user code, including reentrant callbacks and rejected promises.
    slot.operation = undefined
    slot.status = 'running'
    try {
      const result = run(Object.freeze({
        sessionId: slot.owner.sessionId, revision: slot.revision,
        data: slot.data, signal: slot.controller.signal
      }))
      void Promise.resolve(result).then(
        () => this.#finish(slot, 'done'),
        () => this.#finish(slot, 'failed')
      )
      if (this.#current(slot)) this.#changed(slot.key)
    } catch {
      this.#finish(slot, 'failed')
    }
  }

  #finish(slot: Slot, status: 'done' | 'failed') {
    // A late result cannot paint over a replacement or resurrect a disposed/foreign card.
    if (!this.#current(slot)) return
    slot.status = status
    this.#changed(slot.key)
  }
}
