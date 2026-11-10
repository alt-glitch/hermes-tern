import { agentName } from '../agents/rows.js'
import { openAgents } from '../overlays/agents.js'
import { openSidebar, specOf } from '../watch/spec.js'

import type { ActionsCx } from './actions.js'

/** Open an owned agent pane, retaining the timeline fallback when panes are unavailable. */
export async function openAgentPane(cx: Pick<ActionsCx, 'chat' | 'state' | 'launch'>, id: string) {
  const { chat, state } = cx
  const a = chat.agents.all().find(x => x.id === id)
  const sid = state.ref.live

  if (!a || !sid) {
    return
  }

  const cwd = state.info?.cwd || cx.launch.home || '/'

  if (!(await openSidebar(specOf(a, agentName(a), sid), cwd))) {
    openAgents(chat, { id, watch: true })
  }
}
