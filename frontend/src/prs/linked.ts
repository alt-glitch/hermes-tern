// The PRs linked to the conversation this pane shows, and the review guides written for them: the PR
// pill counts the links, the session sidebar lists them, and each change is written to the pane's
// list file (listFile.ts), which the Tern plugin `prs` shows beside the chat. Nothing here reads GitHub.

import { type LiveSessionId, prKey } from '../core/ids.js'
import type { ToolCall } from '../model.js'

import { type Guides, guideKey, guideWritten, type Linked, linkedFromResult, type PrRef } from './links.js'

export interface LinkedPrsHost {
  /** The session the links belong to: its runtime id, what the plugin's method is called in. */
  sid(): LiveSessionId | null
  /** The links and guides of session `sid`'s conversation (links.ts). */
  links(sid: LiveSessionId): Promise<Linked>
  /** The links or guides changed (or the pane adopted a session): the list file and the view follow. */
  changed(linked: Linked): void
  /** A turn wrote the guide of `ref`: show it. */
  guideWritten(ref: PrRef): void
}

const same = (a: Linked, b: Linked) =>
  a.refs.map(prKey).join() === b.refs.map(prKey).join() && JSON.stringify(a.guides) === JSON.stringify(b.guides)

export class LinkedPrs {
  readonly #host: LinkedPrsHost
  #sid: LiveSessionId | null = null
  #linked: Linked = { guides: {}, refs: [] }
  /** Bumped by every change, so a read that started before one drops its answer. */
  #version = 0

  constructor(host: LinkedPrsHost) {
    this.#host = host
  }

  /** The links, oldest first. */
  entries(): readonly PrRef[] {
    return this.#linked.refs
  }

  /** The guides, by `owner/repo#number`. */
  guides(): Guides {
    return this.#linked.guides
  }

  /** The newest link to PR number `n`. */
  find(n: number): PrRef | undefined {
    return this.#linked.refs.findLast(r => r.number === n)
  }

  /** The pane shows another session: its links replace the old ones. */
  adopt() {
    const sid = this.#host.sid()

    if (sid === this.#sid) {
      return
    }

    this.#sid = sid
    this.#set({ guides: {}, refs: [] })
    this.relink()
  }

  /** A finished tool call: a link tool's result is the conversation's whole list and its guides. */
  onCall(call: Pick<ToolCall, 'name' | 'outcome' | 'result'>) {
    const linked = linkedFromResult(call)

    if (linked && !same(linked, this.#linked)) {
      this.#set(linked)
    }

    const written = guideWritten(call)
    const ref = written ? this.#linked.refs.findLast(r => guideKey(r) === written) : undefined

    if (ref) {
      this.#host.guideWritten(ref)
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

    if (linked && sid === this.#sid && version === this.#version && !same(linked, this.#linked)) {
      this.#set(linked)
    }
  }

  #set(linked: Linked) {
    this.#linked = linked
    this.#version++
    this.#host.changed(linked)
  }
}
