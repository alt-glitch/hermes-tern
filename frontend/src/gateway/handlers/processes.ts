// The session's background processes as the gateway streams them: a process's output, which the
// store folds into its card's live line and the Background sheet.

import type { Processes } from '../../processes/store.js'
import type { Handlers } from '../dispatch.js'

/** What the processes' events reach of the app. */
export interface ProcessesCx {
  readonly processes: Pick<Processes, 'output'>
}

/** The processes' events. */
export const processHandlers = {
  // Quiet here: the store asks for its own render once it folded the chunk.
  'agent.terminal.output': (ev, cx) => {
    if (ev.payload?.process_id) {
      cx.processes.output(ev.payload.process_id, ev.payload.chunk ?? '')
    }

    return 'quiet'
  }
} satisfies Handlers<ProcessesCx>
