// session.create's params on either gateway. The shared gateway takes the launch flags
// (`hermes tern -m … --yolo -s …`) as the session's creation policy; a private one lays its output
// out for the pane's width.

import { localCreationOptions } from '@tui/canonicalGateway.js'

import type { Params } from '../wire/rpc.js'

/** What session.create is sent: `cwd` (when set) is the folder the session starts in. */
export function createParams({ canonical, cols, cwd }: { canonical: boolean; cols: number; cwd: string }): Params<'session.create'> {
  return canonical ? { ...localCreationOptions(), ...(cwd ? { cwd } : {}) } : { cols, ...(cwd ? { cwd } : {}) }
}
