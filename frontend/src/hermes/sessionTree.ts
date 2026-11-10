// /tree reads the same conversations as /sessions, through the gateway. session.list folds
// compression chains but exposes no branch parents or branch/reset/delegation markers. Until
// that contract grows lineage, show a forest of available conversations, never guessed edges.

import type { Requester } from '../wire/rpc.js'

import { type ListedSession, listSessions } from './sessionList.js'

export const BRANCH_LINEAGE_GAP = 'The gateway does not expose branch lineage. Showing available conversations.'

/** A resumable conversation, with its known parent (none is exposed by the current gateway). */
export interface BranchNode extends Pick<ListedSession, 'id' | 'lastActive' | 'lastReply' | 'messages' | 'preview' | 'startedAt' | 'title'> {
  parent: string | null
}

/** Available conversations and the gateway row holding the shown runtime or stored id. */
export interface BranchFamily {
  nodes: BranchNode[]
  at: string | null
}

export interface TreeRow {
  node: BranchNode
  depth: number
  children: number
}

/** Gateway-listed conversations only; missing lineage is not evidence that a session has no branches. */
export async function branchFamily(id: string, gw: Requester): Promise<BranchFamily> {
  const sessions = await listSessions(gw)
  const current = sessions.find(s => s.id === id || s.conversation === id)
  const nodes = sessions
    .filter(s => s.source !== 'tool' && s.source !== 'subagent' && (s.messages > 0 || s === current))
    .map((s): BranchNode => ({
      id: s.id,
      lastActive: s.lastActive,
      lastReply: s.lastReply,
      messages: s.messages,
      parent: null,
      preview: s.preview,
      startedAt: s.startedAt,
      title: s.title
    }))

  return { at: nodes.some(n => n.id === current?.id) ? current?.id ?? null : null, nodes }
}

/** Each node under its known parent, siblings oldest first. */
export function treeRows(nodes: readonly BranchNode[]): TreeRow[] {
  const ids = new Set(nodes.map(n => n.id))
  const under = new Map<string | null, BranchNode[]>()

  for (const n of nodes) {
    const parent = n.parent && ids.has(n.parent) ? n.parent : null
    under.set(parent, [...(under.get(parent) ?? []), n])
  }

  for (const list of under.values()) {
    list.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1))
  }

  const out: TreeRow[] = []
  const seen = new Set<string>()
  const stack = [...(under.get(null) ?? [])].reverse().map(node => ({ depth: 0, node }))

  for (let at = stack.pop(); at; at = stack.pop()) {
    if (seen.has(at.node.id)) {
      continue
    }

    seen.add(at.node.id)
    const children = under.get(at.node.id) ?? []
    out.push({ children: children.length, depth: at.depth, node: at.node })
    stack.push(...[...children].reverse().map(node => ({ depth: at.depth + 1, node })))
  }

  return out
}
