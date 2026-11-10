import { describe, expect, it, vi } from 'vitest'

import { liveSessionId, storedSessionId } from '../core/ids.js'
import { BRANCH_LINEAGE_GAP, type BranchFamily, branchFamily, type BranchNode, treeRows } from '../hermes/sessionTree.js'
import type { Overlay } from '../overlays/overlay.js'
import { openBranchTree, type TreeHost } from '../overlays/tree.js'
import { Transcript } from '../transcript/store.js'

import { FakeGateway, key, must, tree } from './fakes.js'

const row = (id: string, started: number) => ({
  id,
  last_active_at: started + 5,
  last_reply: `${id} reply`,
  message_count: 4,
  preview: `${id} prompt`,
  session_id: id,
  source: 'tui',
  started_at: started,
  title: id
})

const shape = (f: BranchFamily) => ({ at: f.at, nodes: f.nodes.map(n => [n.id, n.parent]) })

function gateway() {
  return new FakeGateway({
    replies: {
      'session.list': p => p['scope'] === 'live'
        ? { sessions: [{ ...row('current-live', 3), id: 'current-stored' }] }
        : { sessions: [row('root', 1), row('b2', 2), row('current-stored', 3)] }
    }
  })
}

describe('branchFamily through the gateway', () => {
  it('reads both picker scopes and folds duplicate stored/live identities without inventing branch edges', async () => {
    const gw = gateway()
    const family = await branchFamily('current-stored', gw.client)

    expect(shape(family)).toEqual({ at: 'current-live', nodes: [['current-live', null], ['b2', null], ['root', null]] })
    expect(gw.sent('session.list')).toEqual([
      { limit: 200, picker: true, scope: 'live' },
      { limit: 200, picker: true, scope: 'stored' }
    ])
    expect((await branchFamily('current-live', gw.client)).at).toBe('current-live')
  })

  it('uses the gateway-folded facts, first prompt and last reply', async () => {
    const family = await branchFamily('current-stored', gateway().client)

    expect(family.nodes[0]).toMatchObject({
      id: 'current-live', lastActive: 8000, lastReply: 'current-live reply', messages: 4,
      preview: 'current-live prompt', startedAt: 3000, title: 'current-live'
    })
  })

  it('excludes explicit tool/subagent rows and empty litter, but keeps the empty current conversation', async () => {
    const gw = new FakeGateway({ replies: { 'session.list': p => ({ sessions: p['scope'] === 'live' ? [] : [
      { ...row('agent', 5), source: 'subagent' },
      { ...row('tool', 4), source: 'tool' },
      { ...row('empty', 3), message_count: 0 },
      { ...row('current', 2), message_count: 0 },
      row('stored', 1)
    ] }) } })

    expect(shape(await branchFamily('current', gw.client))).toEqual({ at: 'current', nodes: [['current', null], ['stored', null]] })
  })

  it('does not infer parents, compression, resets or archive status from uncontracted fields', async () => {
    const gw = new FakeGateway({ replies: { 'session.list': p => ({ sessions: p['scope'] === 'live' ? [] : [
      { ...row('x', 1), parent_session_id: 'y', model_config: { _branched_from: 'y' }, archived: true },
      { ...row('y', 2), parent_session_id: 'x', end_reason: 'compression' }
    ] }) } })

    expect(shape(await branchFamily('x', gw.client))).toEqual({ at: 'x', nodes: [['y', null], ['x', null]] })
    expect(shape(await branchFamily('y', gw.client))).toEqual({ at: 'y', nodes: [['y', null], ['x', null]] })
  })

  it('keeps available conversations when the current session is not listed', async () => {
    const family = await branchFamily('not-listed', gateway().client)

    expect(family.at).toBeNull()
    expect(family.nodes).toHaveLength(3)
  })

  it('is empty when neither gateway scope has conversations', async () => {
    const gw = new FakeGateway({ replies: { 'session.list': () => ({ sessions: [] }) } })

    expect(await branchFamily('nope', gw.client)).toEqual({ at: null, nodes: [] })
  })

  it('reports a failed gateway read rather than claiming the conversation has no branches', async () => {
    const gw = new FakeGateway({ replies: { 'session.list': () => { throw new Error('offline') } } })

    await expect(branchFamily('root', gw.client)).rejects.toThrow('offline')
  })
})

const node = (id: string, parent: string | null, startedAt: number): BranchNode => ({
  id,
  lastActive: startedAt,
  lastReply: `${id} reply`,
  messages: 2,
  parent,
  preview: '',
  startedAt,
  title: id
})

describe('treeRows', () => {
  it('puts known branches under their parent, siblings oldest first, with depth and child count', () => {
    const rows = treeRows([node('b1a', 'b1', 4), node('b1', 'root', 3), node('root', null, 1), node('b2', 'root', 2)])

    expect(rows.map(r => [r.node.id, r.depth, r.children])).toEqual([
      ['root', 0, 2],
      ['b2', 1, 0],
      ['b1', 1, 1],
      ['b1a', 2, 0]
    ])
  })

  it('keeps a forest when no branch ancestry is known', () => {
    expect(treeRows([node('b', null, 2), node('a', null, 1)]).map(r => [r.node.id, r.depth, r.children])).toEqual([
      ['a', 0, 0], ['b', 0, 0]
    ])
  })
})

function host(stored = 'current-stored', gw = gateway()) {
  const opened: Overlay[] = []
  const transcript = new Transcript()
  const h = {
    changed: vi.fn(),
    close: vi.fn((o: Overlay) => {
      const at = opened.indexOf(o)
      if (at >= 0) {
        opened.splice(at, 1)
        o.onClose?.()
      }
    }),
    gw: gw.client,
    open: (o: Overlay) => void opened.push(o),
    resume: vi.fn(async () => undefined),
    session: { info: null, ref: { live: liveSessionId('current-live'), stored: storedSessionId(stored) } },
    transcript
  } satisfies TreeHost

  return { h, opened, transcript }
}

describe('the gateway conversation tree', () => {
  it('opens immediately, marks the current row by its resume id, and opens another with Enter', async () => {
    const { h, opened } = host()
    const loading = openBranchTree(h)
    const sheet = must(opened[0])
    expect(tree(sheet.node('layer.overlay-1')).p?.['state']).toBe('loading')
    await loading
    const p = must(tree(sheet.node('layer.overlay-1')).p)

    expect(p['layout']).toBe('tree')
    expect(p['order']).toEqual(['root', 'b2', 'current-live'])
    expect(p['current']).toEqual(['current-live'])
    expect(p['selected']).toBe('current-live')
    expect(p['subtitle']).toEqual([{ s: 'muted', t: `3 conversations. ${BRANCH_LINEAGE_GAP}` }])

    sheet.onKey(key('up'))
    sheet.onKey(key('enter'))

    expect(h.resume).toHaveBeenCalledWith('b2')
    expect(opened).toEqual([])
  })

  it('Enter on the open conversation only closes the sheet', async () => {
    const { h, opened } = host()
    await openBranchTree(h)
    must(opened[0]).onKey(key('enter'))

    expect(h.resume).not.toHaveBeenCalled()
    expect(opened).toEqual([])
  })

  it('keeps a useful singleton tree without claiming there are no branches', async () => {
    const { h, opened, transcript } = host('solo')
    await openBranchTree(h, async () => ({ at: 'solo', nodes: [node('solo', null, 1)] }))
    const p = must(tree(must(opened[0]).node('layer.overlay-1')).p)

    expect(p['total']).toBe(1)
    expect(p['title']).toBe('Conversations')
    expect(JSON.stringify(p['subtitle'])).toContain(BRANCH_LINEAGE_GAP)
    expect(transcript.entries).toEqual([])
  })

  it('shows an empty gateway result without pretending to have read a database', async () => {
    const { h, opened } = host()
    await openBranchTree(h, async () => ({ at: null, nodes: [] }))
    const p = must(tree(must(opened[0]).node('layer.overlay-1')).p)

    expect(p['state']).toBe('ready')
    expect(p['items']).toEqual([])
    expect(p['empty']).toBe('No conversations are available from the gateway yet.')
  })

  it('reports gateway errors in the sheet and transcript', async () => {
    const { h, opened, transcript } = host()
    await openBranchTree(h, async () => { throw new Error('offline') })

    expect(tree(must(opened[0]).node('layer.overlay-1')).p?.['state']).toBe('error')
    expect(transcript.entries.at(-1)).toMatchObject({ kind: 'notice', text: 'Could not read conversations: offline' })
  })

  it('does not reopen a closed tree when its read completes', async () => {
    const { h, opened } = host()
    const pending = Promise.withResolvers<BranchFamily>()
    const loading = openBranchTree(h, () => pending.promise)
    must(opened[0]).onKey(key('escape'))
    h.changed.mockClear()
    pending.resolve({ at: 'solo', nodes: [node('solo', null, 1)] })
    await loading

    expect(opened).toEqual([])
    expect(h.changed).not.toHaveBeenCalled()
  })

  it('drops a late read when the session changes', async () => {
    const { h, opened } = host()
    const pending = Promise.withResolvers<BranchFamily>()
    const loading = openBranchTree(h, () => pending.promise)
    h.session.ref = { live: liveSessionId('other-live'), stored: storedSessionId('other-stored') }
    pending.resolve({ at: 'solo', nodes: [node('solo', null, 1)] })
    await loading

    expect(opened).toEqual([])
    expect(h.resume).not.toHaveBeenCalled()
  })
})
