// Every control a click works on is a native button with a name. Tern focuses buttons and fields
// only: a clickable row, icon or key is a pointer target and nothing else, with no Tab stop, no
// Enter or Space and no name a screen reader can say. These tests walk what the pane draws (each
// golden replay's frames, the dock with its pills and chips, the goal and loop line, the PR sheet,
// a connect card and a background process line) and list every click target the keyboard cannot
// reach, so a new control drawn as a bare clickable row fails here.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type JSX, node, type NodeJson } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { prKey, toolCallId } from '../core/ids.js'
import type { PrRef, PullRequest } from '../github/pullRequest.js'
import type { Listed, PullRequests } from '../github/store.js'
import { PrView } from '../prs/view.js'
import { Transcript } from '../transcript/store.js'
import { automationNode } from '../view/automation.js'
import { dockNodes, imageChip } from '../view/dock.js'
import { toolNode } from '../view/tools/shell.js'
import { button, PRESS_CLASS, pressable } from '../view/ui/button.js'
import { parseJson, record } from '../wire/json.js'

import { dockActions, dockContext } from './dockFakes.js'
import { must, stub, tree } from './fakes.js'

/**
 * The composer's model and effort chips stay rows. Tern's composer lays them out itself: at a
 * narrow width it cuts the effort chip and draws its glyph on the model chip, finding both by role
 * among the bar's children, and a button around either hides it from that. They are named by their
 * titles, and ⇧⇥ and /model reach them from the keyboard.
 */
const TERN_LAYS_OUT = new Set(['omp.composer.effort', 'omp.composer.model'])

/** The click targets under `n` that the keyboard and a screen reader cannot press, each as its path of kinds and roles. */
function unreachable(n: unknown, path: readonly string[] = [], inButton = false): string[] {
  if (Array.isArray(n)) {
    return n.flatMap(c => unreachable(c, path, inButton))
  }

  const wire = record(n)

  if (!wire) {
    return []
  }

  if (typeof wire['k'] !== 'string') {
    // A replay's step, a frame or its regions: the nodes are in its fields.
    return Object.values(wire).flatMap(v => unreachable(v, path, inButton))
  }

  const p = record(wire['p']) ?? {}
  const role = p['role']
  const here = [...path, typeof role === 'string' ? `${wire['k']}[${role}]` : wire['k']]
  const at = here.join(' > ')
  const actions = record(p['actions'])
  const aria = p['aria']
  const named = typeof aria === 'string' && aria.trim() !== ''
  const isButton = wire['k'] === 'el' && p['tag'] === 'button'
  const problems: string[] = []

  if (isButton && inButton) {
    problems.push(`${at}: a button inside a button`)
  } else if (isButton && !named) {
    problems.push(`${at}: a button with no name`)
  } else if (actions && 'click' in actions && !isButton && !exempt(wire['k'], p, named)) {
    problems.push(`${at}: clickable, not a button`)
  }

  return [...problems, ...unreachable(wire['c'], here, inButton || isButton)]
}

/**
 * A click target Tern owns the layout of: a named segment of the status strip (each one this
 * plugin makes clickable repeats a composer button), and the model and effort chips.
 */
function exempt(kind: string, p: Record<string, unknown>, named: boolean): boolean {
  const role = p['role']

  return (kind === 'seg' && named) || (kind === 'row' && typeof role === 'string' && TERN_LAYS_OUT.has(role) && typeof p['title'] === 'string')
}

/** The wire form of what a view function drew. */
const wire = (drawn: JSX.Element | null | readonly (JSX.Element | null)[]): NodeJson[] =>
  (Array.isArray(drawn) ? drawn : [drawn]).flatMap((e: JSX.Element | null) => (e ? [tree(e)] : []))

const GOLDEN = join(import.meta.dirname, '__snapshots__', 'golden')
const noop = () => undefined

describe('every control is a named native button', () => {
  it('lists a clickable row, a button with no name and a button inside a button', () => {
    const row = tree(node('row', { key: 'r', onClick: noop, role: 'omp.btn' }))
    const nameless = { c: [], k: 'el', p: { actions: { click: 'click' }, tag: 'button' } }
    const nested = tree(pressable({ key: 'a', name: 'Outer', onClick: noop }, pressable({ key: 'b', name: 'Inner', onClick: noop }, node('text', { key: 't', text: 'x' }))))

    expect(unreachable([row, nameless, nested])).toEqual(['row[omp.btn]: clickable, not a button', 'el: a button with no name', 'el > el: a button inside a button'])
  })

  it('wraps the control in the button, which takes the click and the name; the control keeps its role and title', () => {
    const n = tree(button({ hint: 'esc', key: 'x', keys: ['escape'], label: 'Close', onClick: noop }))

    expect(n).toMatchObject({ k: 'el', p: { actions: { click: 'click' }, aria: 'Close', class: PRESS_CLASS, key: 'x', tag: 'button' } })
    expect(n.c?.[0]).toMatchObject({ k: 'row', p: { role: 'omp.btn', title: 'Close  esc' } })
    expect(n.c?.[0]?.p?.['actions']).toBeUndefined()
    expect(unreachable([n])).toEqual([])
  })

  it('in every frame of the golden replays', () => {
    const files = readdirSync(GOLDEN).filter(f => f.endsWith('.json'))
    expect(files.length).toBeGreaterThan(0)

    for (const f of files) {
      const frames = record(parseJson(readFileSync(join(GOLDEN, f), 'utf8')))?.['frames']
      expect(JSON.stringify(frames), f).toContain('"tag":"button"')
      expect(unreachable(frames), f).toEqual([])
    }
  })

  it('in the dock: send and stop, every pill, the queue and an image chip', () => {
    const on = dockActions({ onEffortMenu: { choose: vi.fn() } })
    const pills = {
      agents: 2,
      prs: { text: '#5 · checks passing', tone: 'success' as const },
      shells: { exited: 0, running: 1, tone: 'success' as const },
      todos: {
        list: [
          { content: 'one', id: '1', status: 'completed' as const },
          { content: 'two', id: '2', status: 'in_progress' as const }
        ],
        open: false
      }
    }
    const idle = dockContext({
      composer: { ...dockContext().composer, attachments: [{ caption: '12 KB', label: 'shot.png' }] },
      pills,
      route: { effort: 'high', fast: 'fast', model: 'm' }
    })
    const busy = dockContext({
      activity: { kind: 'turn', label: 'Working', since: {}, startedAt: 0 },
      pills,
      queue: { canSteer: true, rows: [{ kind: 'local', steer: true, text: 'next' }] }
    })

    expect(unreachable(wire(dockNodes(idle, on)))).toEqual([])
    expect(unreachable(wire(dockNodes(busy, on)))).toEqual([])
    expect(JSON.stringify(wire(dockNodes(busy, on)))).toContain('"omp.queue.steer"')
    expect(unreachable(wire(imageChip({ label: 'shot.png' }, 0, vi.fn())))).toEqual([])
  })

  it('in the goal and loop line', () => {
    const line = automationNode(
      {
        goal: { criteria: [], detail: '', maxTurns: 5, state: 'active', title: 'Ship it', turns: 1 },
        loop: { cadence: 'every 5m', detail: '', fired: 2, prompt: 'check CI', runs: '2 runs', state: 'active', times: 0, until: '' },
        loopOwner: null,
        onGoal: vi.fn(),
        onLoop: vi.fn()
      },
      0
    )

    expect(unreachable(wire(line))).toEqual([])
  })

  it('in the PR sheet: the checkout command, the checks, the file list and the actions', () => {
    const ref: PrRef = { host: 'github.com', number: 5, repository: 'acme/app', url: 'https://github.com/acme/app/pull/5' }
    const pr = stub<PullRequest>({
      additions: 1,
      author: 'sid',
      base: 'main',
      body: '',
      canUpdate: true,
      changedFiles: 1,
      checks: [],
      createdAt: '2026-10-19T10:00:00Z',
      deletions: 0,
      draft: false,
      head: 'fix',
      labels: [],
      mergeMethods: ['squash'],
      mergeable: 'mergeable',
      number: 5,
      repository: 'acme/app',
      reviewDecision: null,
      reviewers: [],
      state: 'open',
      title: 'Fix the thing',
      updatedAt: '2026-10-19T10:00:00Z',
      url: ref.url
    })
    const files = [{ additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b', path: 'src/a.ts', status: 'modified' }]
    const entry: Listed = { activity: { kind: 'idle' }, files: { at: pr.updatedAt, kind: 'ready', value: files }, pr, ref, source: 'linked' }
    const prs = { activity: vi.fn(async () => {}), busy: () => false, entries: () => [entry], files: vi.fn(async () => {}), get: () => entry, poke: vi.fn() }
    const view = new PrView({ changed: vi.fn(), notice: vi.fn(), open: vi.fn(), prs: stub<PullRequests>(prs) }, prKey(ref))

    view.setTab('files')
    const drawn = wire([view.header(0), view.tabBar(), ...view.body('b', 0, 'wide'), view.actions()])

    expect(unreachable(drawn)).toEqual([])
    expect(JSON.stringify(drawn)).toContain('"hermes.pr.fileitem"')
  })

  it('in a connect card and a background process line', () => {
    const transcript = new Transcript()
    transcript.messageStart()
    transcript.toolStart({ args: { action: 'connect' }, name: 'manage_connections', tool_id: 'c1' })
    transcript.toolStart({ args: { background: true, command: 'sleep 90' }, name: 'terminal', tool_id: 't1' })
    transcript.toolComplete({ name: 'terminal', result: JSON.stringify({ exit_code: 0, output: 'Background process started', session_id: 'proc_a' }), tool_id: 't1' })
    const connect = must(transcript.call(toolCallId('c1')))
    connect.connect = { opened: [], targets: [{ name: 'github', state: 'initiated', title: 'GitHub', url: 'https://example.com/auth' }], told: false }

    const card = wire(toolNode(connect, 0))
    const shell = wire(toolNode(must(transcript.call(toolCallId('t1'))), 0))

    expect(unreachable(card)).toEqual([])
    expect(JSON.stringify(card)).toContain('connect-open=')
    expect(unreachable(shell)).toEqual([])
    expect(JSON.stringify(shell)).toContain('open-process=proc_a')
  })
})
