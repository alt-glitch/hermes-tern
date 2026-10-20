// The app's two outside parties as in-process fakes, for tests that drive App: a Tern session
// (keys and events in, frames out) and a gateway (requests recorded and answered, events fed in).
// The casts to the real types live here, once, so test files hand App typed values.
import { EventEmitter } from 'node:events'

import type { Key, Session } from '@stencil-hq/tern'
import type { GatewayClient } from '@tui/gatewayClient.js'

/** One gateway answer: `request` resolves to what it returns and rejects with what it throws. */
export type Reply = (params: Record<string, unknown>) => unknown

/** One request the app sent. */
export interface Call {
  method: string
  params: Record<string, unknown>
}

/** A key as Tern reports it: `name` with no modifiers unless `mods` says so. */
export function key(name: string, mods: Partial<Key> = {}): Key {
  return { alt: false, ctrl: false, meta: false, name, shift: false, ...mods } as Key
}

/** A shared-gateway stand-in: `request` answers from `handlers` (else `{}`), `event` feeds the app. */
export class FakeGateway extends EventEmitter {
  isCanonical: boolean
  attached = true
  readonly calls: Call[] = []
  readonly handlers: Map<string, Reply>

  constructor({ canonical = true, replies = {} }: { canonical?: boolean; replies?: Record<string, Reply> } = {}) {
    super()
    this.isCanonical = canonical
    this.handlers = new Map(Object.entries(replies))
  }

  /** This fake as the gateway type App takes. */
  get client(): GatewayClient {
    return this as unknown as GatewayClient
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params })
    const handler = this.handlers.get(method)

    try {
      return Promise.resolve(handler ? handler(params) : {})
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /** The requests sent for `name`. */
  methods(name: string): Call[] {
    return this.calls.filter(c => c.method === name)
  }

  /** The params of each request sent for `name`. */
  sent(name: string): Record<string, unknown>[] {
    return this.methods(name).map(c => c.params)
  }

  /** Delivers one gateway event to the app. */
  event(ev: Record<string, unknown>) {
    this.emit('event', ev)
  }

  drain() {}
  kill() {}
  holdAttach() {
    return undefined
  }
  settleAttach() {}
  hydrateSharedPrompts() {}
}

/** One input the app's loop reads from Tern. */
export type TernInput = { type: 'key'; key: Key } | { type: 'event'; event: Record<string, unknown> }

export interface FakeTernOptions {
  cols?: number
  /** Whether the surface draws: it keeps each tree it is given (`frame`). A closed one draws nothing. */
  draws?: boolean
  features?: string[]
}

/** A Tern session on no terminal: `press` and `send` feed the app's input loop, `frame` is what it drew last. */
export function fakeTern({ cols = 80, draws = false, features = [] }: FakeTernOptions = {}) {
  const inputs: TernInput[] = []
  const waiting: ((r: IteratorResult<TernInput>) => void)[] = []
  let frame: unknown

  const blank: object = new Proxy({}, { get: (_, name) => (name === 'closed' ? true : () => blank) })
  const surface = draws
    ? {
        closed: false,
        focus: () => undefined,
        palette: () => undefined,
        render: (tree: unknown) => void (frame = tree),
        stylesheet: () => undefined
      }
    : blank

  const input = (value: TernInput) => {
    const wake = waiting.shift()

    if (wake) {
      wake({ done: false, value })
    } else {
      inputs.push(value)
    }
  }

  const session = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const value = inputs.shift()

        return value ? Promise.resolve({ done: false as const, value }) : new Promise<IteratorResult<TernInput>>(resolve => waiting.push(resolve))
      },
      return: async () => ({ done: true as const, value: undefined })
    }),
    blob: () => 'blob',
    caps: { cols, features },
    close: async () => undefined,
    open: () => surface
  }

  return {
    /** This fake as the Tern session type App takes. */
    session: session as unknown as Session,
    /** The tree the surface drew last (undefined until a drawing surface renders). */
    get frame(): unknown {
      return frame
    },
    /** Whether the app's input loop waits for its next input. */
    get reading(): boolean {
      return waiting.length > 0
    },
    /** Delivers key `k` (a name: that key with no modifiers). */
    press: (k: Key | string) => input({ key: typeof k === 'string' ? key(k) : k, type: 'key' }),
    /** Delivers one Tern event. */
    send: (event: Record<string, unknown>) => input({ event, type: 'event' })
  }
}


/**
 * Lets the app finish what its last input or event started: one event-loop turn (its render is a
 * setImmediate), and another while each turn sent the gateway more requests. A reply a test holds
 * open is not waited for.
 */
export async function settle(gw: FakeGateway) {
  let sent: number

  do {
    sent = gw.calls.length
    await new Promise(resolve => setImmediate(resolve))
  } while (gw.calls.length !== sent)
}
