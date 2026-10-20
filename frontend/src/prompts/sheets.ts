// The prompt sheets on the overlay stack: one per question the gateway asks (an approval, a
// clarify card, a password or secret), keyed `prompt:<request id>`. The gateway withdraws them by
// request id (request.cancel), by shared prompt id (approval.settled, clarify.settled), or by the
// approval queue's own ids (approval.cancelled), and a reattach, a switch or a lost gateway drops
// them all. The key is built here, once, and only here is a key read back.

import type { ServerRequest } from '@hermes/shared/json-rpc-channel'

import { type OverlayKey, overlayKey } from '../core/ids.js'
import { sharedPromptId } from '../hermes/sharedPrompts.js'
import type { Overlay, OverlayHost } from '../overlay.js'

const PREFIX = 'prompt:'

/** The overlay key of the sheet that answers request `id`. */
export const promptKey = (id: string): OverlayKey => overlayKey(`${PREFIX}${id}`)

/** What the prompt sheets reach of the app: its overlay stack. */
export type SheetsHost = Pick<OverlayHost, 'close' | 'open'> & {
  /** The open overlays, bottom first. */
  readonly overlays: readonly Overlay[]
}

/** The open prompt sheets, and the approval-queue ids of the approvals among them. */
export class PromptSheets {
  readonly #host: SheetsHost
  /** Open approval sheets' keys → their approval-queue `request_id` (what approval.cancelled names). */
  readonly #approvals = new Map<string, string>()

  constructor(host: SheetsHost) {
    this.#host = host
  }

  /** Opens `overlay`, the sheet for `req`; an approval's queue id is kept while the sheet is open. */
  open(overlay: Overlay, req: ServerRequest) {
    this.#host.open(overlay)
    const queued = req.params['request_id']

    if (req.method === 'approval' && typeof queued === 'string') {
      this.#approvals.set(overlay.key, queued)
    }
  }

  /** `overlay` left the stack (the app's close): its approval id goes with it. */
  closed(overlay: Overlay) {
    this.#approvals.delete(overlay.key)
  }

  /** Whether the sheet for request `id` is open. */
  shows(id: string | undefined): boolean {
    const key = promptKey(String(id))

    return this.#host.overlays.some(o => o.key === key)
  }

  /**
   * Closes the sheet for request `id`: request.cancel's, or a shared prompt's `sharedPromptId`
   * (approval.settled, clarify.settled).
   */
  drop(id: string | undefined) {
    const key = promptKey(String(id))

    this.#drop(k => k === key)
  }

  /** Closes every shared prompt's sheet: a resume re-hydrates those still pending. */
  dropShared() {
    const prefix = promptKey(sharedPromptId(''))

    this.#drop(k => k.startsWith(prefix))
  }

  /** Closes the approvals whose queue ids `requestIds` names (approval.cancelled). */
  dropByApproval(requestIds: readonly string[] | undefined) {
    this.#drop(k => requestIds?.includes(this.#approvals.get(k) ?? '') ?? false)
  }

  /** Closes every prompt sheet: nothing can answer them now, or they are another session's. */
  dropAll() {
    this.#drop(() => true)
  }

  /** Closes the prompt sheets whose key `picked` names; other overlays stay. */
  #drop(picked: (key: string) => boolean) {
    for (const o of [...this.#host.overlays]) {
      if (o.key.startsWith(PREFIX) && picked(o.key)) {
        this.#host.close(o)
      }
    }
  }
}
