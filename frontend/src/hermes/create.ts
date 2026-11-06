// session.create's params on either gateway. The shared gateway takes the launch flags
// (`hermes tern -m … --yolo -s …`, which the launcher hands over as HERMES_TERN_CREATE) as the
// session's creation policy; a private one lays its output out for the pane's width.

import type { Params } from '../wire/rpc.js'

/** What session.create is sent: `cwd` (when set) is the folder the session starts in. */
export function createParams({
  canonical,
  cols,
  create,
  cwd
}: {
  canonical: boolean
  cols: number
  create: Readonly<Record<string, unknown>>
  cwd: string
}): Params<'session.create'> {
  return canonical ? { ...create, ...(cwd ? { cwd } : {}) } : { cols, ...(cwd ? { cwd } : {}) }
}
