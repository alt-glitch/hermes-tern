// Which session this pane shows, told to the plugin's Python half over plugin RPC (viewers.py):
// `viewer.set` on every adopt (a new session, a resume, a reattach after a reconnect, so a gateway
// restart learns it again), `viewer.clear` when the pane stops showing it. With it the agent's
// commands get this pane's Tern variables (so `tern open` lands beside the chat). A restarted pane
// asks `viewer.shown` before it resumes its last conversation.

import type { SessionIds, SessionRef } from '../core/ids.js'
import type { Requester } from '../wire/rpc.js'

/** The Tern variables that name this pane, its window and their sockets: the agent's tools get them, so `tern` finds this pane. */
export const TERN_PANE_VARS = ['TERN_PANE', 'TERN_PANE_SOCKET', 'TERN_WINDOW_KEY', 'TERN_WINDOW_SOCKET', 'TERN_DAEMON_SOCKET'] as const

/** This pane's Tern variables (only the set ones), or undefined outside a Tern pane. */
export function ternPane(env: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
  const vars = Object.fromEntries(TERN_PANE_VARS.flatMap(k => (env[k] ? [[k, env[k]]] : [])))

  return vars['TERN_PANE'] ? vars : undefined
}

/** The plugin's methods (viewers.py). */
export const VIEWER_SET = 'plugin.hermes-tern.viewer.set'
export const VIEWER_CLEAR = 'plugin.hermes-tern.viewer.clear'
export const VIEWER_SHOWN = 'plugin.hermes-tern.viewer.shown'

/** How long quitting waits for its `viewer.clear` (a dead pane counts for nothing anyway: its pid is checked). */
const CLEAR_WAIT_MS = 300

/** What a call names: the session's live id (the call's authorization) and its stored id, when it has another. */
const target = (ref: SessionIds) => ({ session_id: ref.live, ...(ref.stored && String(ref.stored) !== String(ref.live) ? { stored: ref.stored } : {}) })

export class Viewer {
  readonly #gw: Requester
  readonly #tern: Record<string, string>
  readonly #pid: number

  constructor(gw: Requester, env: NodeJS.ProcessEnv = process.env, pid = process.pid) {
    this.#gw = gw
    this.#tern = ternPane(env) ?? {}
    this.#pid = pid
  }

  /** This pane shows `now`, and no longer `before`. */
  show(now: SessionRef, before: SessionIds | null) {
    if (before?.live && before.live !== now.live) {
      void this.#call(VIEWER_CLEAR, { ...target(before), pid: this.#pid })
    }

    if (now.live) {
      void this.#call(VIEWER_SET, { ...target(now), pid: this.#pid, tern: this.#tern })
    }
  }

  /** This pane stops showing `ref` (it quits): waits a moment for the gateway to hear it. */
  async leave(ref: SessionIds): Promise<void> {
    if (!ref.live) {
      return
    }

    await Promise.race([this.#call(VIEWER_CLEAR, { ...target(ref), pid: this.#pid }), new Promise(r => setTimeout(r, CLEAR_WAIT_MS))])
  }

  /** Whether a live pane shows conversation `id`; false when the gateway cannot say. */
  async shown(id: string): Promise<boolean> {
    try {
      const r = await this.#gw.request<unknown>(VIEWER_SHOWN, { ids: [id] })

      return typeof r === 'object' && r !== null && 'shown' in r && r.shown === true
    } catch {
      return false
    }
  }

  async #call(method: string, params: Record<string, unknown>): Promise<void> {
    try {
      await this.#gw.request(method, params)
    } catch {
      // A gateway without the plugin's methods, or a session that went: nothing to tell.
    }
  }
}
