// The branch tree (`/tree`): the conversations this one was branched from or into, from the
// profile's state.db (hermes/sessionTree.ts), each under the one it copied, the open one marked.
// Enter opens the picked branch in this view, as /sessions does. A branch keeps no record of where
// in its parent it was cut, so the tree shows when each began, not after which message.

import type { JSX, Key, PickerItem, Span } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import { optional } from '../core/assert.js'
import { errorText } from '../core/errors.js'
import { durable, storedSessionId } from '../core/ids.js'
import { plural } from '../core/text.js'
import { lastReply, sessionLabel } from '../hermes/sessionIndex.js'
import { type BranchFamily, type BranchNode, branchFamily, type TreeRow, treeRows } from '../hermes/sessionTree.js'
import { oneLine } from '../view/describe.js'
import { ageShort } from '../view/format.js'
import { facts } from '../view/ui/facts.js'

import type { Overlay } from './overlay.js'
import { moveSelection } from './search.js'

/** What the branch tree reaches of the app. */
export type TreeHost = Pick<ChatPorts, 'changed' | 'close' | 'open' | 'resume' | 'session' | 'transcript'>

const KEY = 'tree'

/** Opens the branch tree of the shown session; `family` reads it (state.db by default). */
export function openBranchTree(host: TreeHost, family: (id: string) => BranchFamily = id => branchFamily(id)) {
  const shown = durable(host.session.ref)
  // The open view may name a continuation of its conversation: `at` is the node that holds it.
  const { at: current, nodes } = shown ? family(shown) : { at: null, nodes: [] }

  if (nodes.length < 2) {
    host.transcript.notice(
      nodes.length ? 'This conversation has no branches yet. /branch makes one.' : 'This conversation is not stored yet: nothing to show.'
    )
    host.changed()

    return
  }

  const tree = treeRows(nodes)
  const order = tree.map(r => r.node.id)
  let selected = current ?? order[0]
  const replies = new Map<string, string>()

  const open = (id: string | undefined) => {
    const row = tree.find(r => r.node.id === id)

    if (!row) {
      return
    }

    host.close(overlay)

    if (row.node.id !== current) {
      host.resume(storedSessionId(row.node.id)).catch((error: unknown) => {
        host.transcript.notice(`Could not open the branch: ${errorText(error)}`, 'error')
        host.changed()
      })
    }
  }

  const overlay: Overlay = {
    key: KEY,
    modal: true,
    node: () => {
      const now = Date.now()
      const row = tree.find(r => r.node.id === selected)

      if (row && !replies.has(row.node.id)) {
        replies.set(row.node.id, lastReply(row.node.id))
      }

      return (
        <picker
          actions={[
            { end: true, id: 'close', keys: ['esc'], label: 'Close' },
            { ...optional('disabled', row ? undefined : 'No branch'), id: 'open', keys: ['enter'], label: row?.node.id === current ? 'Back to it' : 'Open', primary: true }
          ]}
          columns={[
            { format: 'dim', id: 'size', priority: 1 },
            { format: 'time', id: 'when', priority: 2 }
          ]}
          current={current ? [current] : []}
          icon="history"
          items={tree.map(r => itemOf(r, now))}
          key={KEY}
          layout="tree"
          noun="branches"
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
          subtitle={[{ s: 'muted', t: plural(tree.length, 'conversation') }]}
          title="Branches"
          total={tree.length}
        >
          {row ? preview(row, nodes, row.node.id === current, replies.get(row.node.id) ?? '', now) : null}
        </picker>
      )
    },
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
}

function itemOf({ children, depth, node }: TreeRow, now: number): PickerItem {
  return {
    badges: node.archived ? [{ text: 'archived' }] : [],
    depth,
    ...optional('detail', node.title && node.preview ? oneLine(node.preview) : undefined),
    facts: { size: plural(node.messages, 'msg'), when: ageShort(now - node.lastActive) },
    id: node.id,
    label: sessionLabel(node),
    // Only a conversation with branches folds.
    ...optional('open', children ? true : undefined)
  }
}

function preview({ children, node }: TreeRow, nodes: readonly BranchNode[], isCurrent: boolean, reply: string, now: number): JSX.Element[] {
  const parent = nodes.find(n => n.id === node.parent)
  const status: Span[] | undefined = isCurrent ? [{ s: 'success', t: 'open here' }] : undefined

  return [
    <text key="title" role="omp.picker.title" text={sessionLabel(node)} />,
    <kv
      items={facts([
        ['Status', status],
        ['Branched from', parent ? sessionLabel(parent) : 'nothing: this is where the family starts'],
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
    ...(reply
      ? [
          <section head="Last reply" key="last">
            <md key="text" max={{ h: '14lines' }} text={reply.slice(0, 2000)} />
          </section>
        ]
      : [])
  ]
}

function dateOf(at: number): string {
  return new Date(at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
}
