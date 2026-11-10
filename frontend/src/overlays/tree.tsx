// /tree uses gateway-listed conversations and previews. Until the gateway exposes branch
// ancestry, each available conversation is a root, and the picker says why there are no edges.

import type { JSX, Key, PickerItem, Span } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import { optional } from '../core/assert.js'
import { errorText } from '../core/errors.js'
import { durable, storedSessionId } from '../core/ids.js'
import { plural } from '../core/text.js'
import { sessionLabel } from '../hermes/sessionList.js'
import { BRANCH_LINEAGE_GAP, type BranchFamily, type BranchNode, branchFamily, type TreeRow, treeRows } from '../hermes/sessionTree.js'
import { oneLine } from '../view/describe.js'
import { ageShort } from '../view/format.js'
import { facts } from '../view/ui/facts.js'

import { nativeOverlayKey } from './identity.js'
import type { Overlay } from './overlay.js'
import { moveSelection } from './search.js'

export type TreeHost = Pick<ChatPorts, 'changed' | 'close' | 'gw' | 'open' | 'resume' | 'session' | 'transcript'>

const KEY = 'tree'

/** Opens immediately; a late gateway reply cannot revive a closed or superseded session's tree. */
export async function openBranchTree(host: TreeHost, family: (id: string) => Promise<BranchFamily> = id => branchFamily(id, host.gw)): Promise<void> {
  const ref = host.session.ref
  const ticket = host.session.ownerTicket?.()
  const owns = () => (!ticket || ticket.isCurrent()) && host.session.ref.live === ref.live && host.session.ref.stored === ref.stored
  let closed = false
  let state: 'loading' | 'ready' | 'error' = 'loading'
  let current: string | null = null
  let nodes: BranchNode[] = []
  let tree: TreeRow[] = []
  let order: string[] = []
  let selected: string | undefined

  const open = (id: string | undefined) => {
    const row = tree.find(r => r.node.id === id)

    if (!row || closed || !owns()) {
      return
    }

    host.close(overlay)

    if (row.node.id !== current) {
      host.resume(storedSessionId(row.node.id)).catch((error: unknown) => {
        host.transcript.notice(`Could not open the conversation: ${errorText(error)}`, 'error')
        host.changed()
      })
    }
  }

  const overlay: Overlay = {
    key: KEY,
    modal: true,
    node: id => {
      const now = Date.now()
      const row = tree.find(r => r.node.id === selected)

      return (
        <picker
          actions={[
            { end: true, id: 'close', keys: ['esc'], label: 'Close' },
            { ...optional('disabled', row ? undefined : 'No conversation'), id: 'open', keys: ['enter'], label: row?.node.id === current ? 'Back to it' : 'Open', primary: true }
          ]}
          columns={[
            { format: 'dim', id: 'size', priority: 1 },
            { format: 'time', id: 'when', priority: 2 }
          ]}
          current={current ? [current] : []}
          empty="No conversations are available from the gateway yet."
          icon="history"
          items={tree.map(r => itemOf(r, now))}
          key={nativeOverlayKey(id)}
          layout="tree"
          noun="conversations"
          onAction={{ close: () => host.close(overlay), open: () => open(selected) }}
          onActivate={ev => open(ev.item)}
          onSelect={ev => {
            selected = ev.item
            host.changed()
          }}
          order={order}
          preview="side"
          {...optional('selected', selected)}
          size="lg"
          state={state}
          subtitle={[{ s: 'muted', t: `${plural(tree.length, 'conversation')}. ${BRANCH_LINEAGE_GAP}` }]}
          title="Conversations"
          total={tree.length}
        >
          {row ? preview(row, nodes, row.node.id === current, now) : null}
        </picker>
      )
    },
    onClose: () => { closed = true },
    onKey: (k: Key) => {
      if (k.name === 'escape') {
        host.close(overlay)
      } else if (k.name === 'enter') {
        open(selected)
      } else {
        selected = moveSelection(k, order, selected) ?? selected
      }

      return true
    }
  }

  host.open(overlay)

  try {
    const result = await family(durable(ref) ?? '')

    if (closed) {
      return
    }

    if (!owns()) {
      host.close(overlay)

      return
    }

    current = result.at
    nodes = result.nodes
    tree = treeRows(nodes)
    order = tree.map(r => r.node.id)
    selected = current ?? order[0]
    state = 'ready'
  } catch (error) {
    if (closed) {
      return
    }

    if (!owns()) {
      host.close(overlay)

      return
    }

    state = 'error'
    host.transcript.notice(`Could not read conversations: ${errorText(error)}`, 'error')
  }

  host.changed()
}

function itemOf({ children, depth, node }: TreeRow, now: number): PickerItem {
  return {
    depth,
    ...optional('detail', node.title && node.preview ? oneLine(node.preview) : undefined),
    facts: { size: plural(node.messages, 'msg'), when: ageShort(now - node.lastActive) },
    id: node.id,
    label: sessionLabel(node),
    ...optional('open', children ? true : undefined)
  }
}

function preview({ children, node }: TreeRow, nodes: readonly BranchNode[], isCurrent: boolean, now: number): JSX.Element[] {
  const parent = nodes.find(n => n.id === node.parent)
  const status: Span[] | undefined = isCurrent ? [{ s: 'success', t: 'open here' }] : undefined

  return [
    <text key="title" role="omp.picker.title" text={sessionLabel(node)} />,
    <kv
      items={facts([
        ['Status', status],
        ['Branched from', parent ? sessionLabel(parent) : 'not provided by the gateway'],
        ['Branches', children ? String(children) : undefined],
        ['Started', dateOf(node.startedAt)],
        ['Last active', `${ageShort(now - node.lastActive)} ago`],
        ['Messages', String(node.messages)],
        ['Session', [{ s: 'mono dim', t: node.id.replace(/^(local-)?(.{12}).*$/, '$1$2…') }]]
      ])}
      key="facts"
    />,
    ...(node.preview
      ? [
          <section head="First prompt" key="first">
            <md key="text" max={{ h: '8lines' }} text={node.preview} tone="user" />
          </section>
        ]
      : []),
    ...(node.lastReply
      ? [
          <section head="Last reply" key="last">
            <md key="text" max={{ h: '14lines' }} text={node.lastReply.slice(0, 2000)} />
          </section>
        ]
      : [])
  ]
}

function dateOf(at: number): string {
  return new Date(at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
}
