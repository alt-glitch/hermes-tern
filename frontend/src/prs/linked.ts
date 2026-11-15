// The PRs linked to the conversation this pane shows: the PR pill counts them, the session sidebar
// lists them, and each change is written to the pane's list file (listFile.ts), which the Tern
// plugin `prs` shows beside the chat. Nothing here reads GitHub.

import { type LiveSessionId, prKey } from '../core/ids.js'
import type { ToolCall } from '../model.js'

import { linkedFromResult, type PrRef } from './links.js'

export interface LinkedPrsHost {
  /** The session the links belong to: its runtime id, what the plugin's method is called in. */
  sid(): LiveSessionId | null
  /** The links of session `sid`'s conversation, oldest first (links.ts). */
  links(sid: LiveSessionId): Promise<PrRef[]>
  /** The list changed (or the pane adopted a session): the list file and the view follow. */
  changed(refs: readonly PrRef[]): void
}

const same = (a: readonly PrRef[], b: readonly PrRef[]) => a.map(prKey).join() === b.map(prKey).join()

export class LinkedPrs {
  readonly #host: LinkedPrsHost
  #sid: LiveSessionId | null = null
  #refs: readonly PrRef[] = []
  /** Bumped by every change, so a read that started before one drops its answer. */
  #version = 0

  constructor(host: LinkedPrsHost) {
    this.#host = host
  }

  /** The links, oldest first. */
  entries(): readonly PrRef[] {
    return this.#refs
  }

  /** The newest link to PR number `n`. */
  find(n: number): PrRef | undefined {
    return this.#refs.findLast(r => r.number === n)
  }

  /** The pane shows another session: its links replace the old ones. */
  adopt() {
    const sid = this.#host.sid()

    if (sid === this.#sid) {
      return
    }

    this.#sid = sid
    this.#set([])
    this.relink()
  }

  /** A finished tool call: a link tool's result is the conversation's whole list. */
  onCall(call: Pick<ToolCall, 'name' | 'outcome' | 'result'>) {
    const linked = linkedFromResult(call)

    if (linked && !same(linked, this.#refs)) {
      this.#set(linked)
    }
  }

  /** Reads the links again (a subagent's link tool changed them). */
  relink() {
    void this.#relink()
  }

  async #relink() {
    const sid = this.#sid

    if (!sid) {
      return
    }

    const version = this.#version
    const linked = await this.#host.links(sid).catch(() => undefined)

    if (linked && sid === this.#sid && version === this.#version && !same(linked, this.#refs)) {
      this.#set(linked)
    }
  }

  #set(refs: readonly PrRef[]) {
    this.#refs = refs
    this.#version++
    this.#host.changed(refs)
  }
}
