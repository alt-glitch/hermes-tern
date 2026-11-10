// Delegated agents in the same compact wait frame as background process jobs.

import { type JSX, Node, type NodeJson } from '@stencil-hq/tern'

import type { Subagent } from '../model.js'
import { pressable } from '../view/ui/button.js'
import { JOB_TILE_LIMIT, jobTile, jobTiles } from '../view/ui/jobTiles.js'
import { record } from '../wire/json.js'

import { SUBAGENT_LOOK } from './look.js'
import { agentName, isRunning } from './rows.js'

const PROGRESS_CHARS = 160
const PROGRESS_LINES = 2

/** A compact, single-line progress note; Tern also clips it to the tile's actual width. */
function compact(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > PROGRESS_CHARS ? `${line.slice(0, PROGRESS_CHARS - 1)}…` : line
}
/** Hermes tool intents use `i`; older logs may use `intent` or only raw arguments. */
function intent(text: string): string {
  const args = record(text)
  const label = args?.['i'] ?? args?.['intent']

  return compact(typeof label === 'string' && label.trim() ? label : text)
}


/** The latest assistant notes or tool intents, never thinking text or tool result output. */
export function agentProgress(a: Subagent): string[] {
  const lines: string[] = []

  for (const e of a.steps ?? []) {
    const line = e.kind === 'assistant' ? compact(e.text) : e.kind === 'tool' ? intent(e.args || e.name) : ''

    if (line && lines.at(-1) !== line) {
      lines.push(line)
    }
  }

  const preview = a.toolPreview && intent(a.toolPreview)

  if (a.tool && preview && !lines.includes(preview)) {
    lines.push(preview)
  }

  return lines.slice(-PROGRESS_LINES)
}

interface TileData {
  id: string
  key: string
  name: string
  status: Subagent['status']
  startedAt: number
  tool: string | undefined
  lines: string[]
}

interface Built {
  signature: string
  node: JSX.Element
}

// running() returns a new array each frame. Anchor the cache to the first actual agent instead.
// Only visible data invalidates it. Elapsed time belongs to Tern, not a frontend tick loop.
const built = new WeakMap<Subagent, Map<string, Built>>()

/** Active agents only, up to the same limit as the process hover card, then a hub link. */
export function agentWaitNode(agents: readonly Subagent[], now: number, key = 'agent-wait'): JSX.Element | undefined {
  const active = agents.filter(isRunning)
  const first = active[0]

  if (!first) {
    return undefined
  }

  const shown: TileData[] = active.slice(0, JOB_TILE_LIMIT).map(a => ({
    id: a.id,
    key: a.key,
    lines: agentProgress(a),
    name: agentName(a),
    startedAt: a.startedAt,
    status: a.status,
    tool: a.status === 'running' ? a.tool : undefined
  }))
  const rest = active.length - shown.length
  const signature = JSON.stringify([shown, rest])
  const cache = built.get(first) ?? new Map<string, Built>()
  const previous = cache.get(key)

  if (previous?.signature === signature) {
    return previous.node
  }

  const node = (
    <col gap="sm" key={key} role="hermes.agents.wait">
      {jobTiles(shown.map(a => agentTile(a, now)))}
      {rest > 0 ? (
        pressable(
          { action: 'open-agents=all', key: 'more', name: `${rest} more agents: open /agents` },
          <text key="face" role="omp.jobs.hovercard.more" spans={[{ s: 'dim', t: `+${rest} more agents · /agents` }]} wrap="none" />
        )
      ) : null}
    </col>
  )
  cache.set(key, { node, signature })
  built.set(first, cache)

  return node
}

/** The dock pill's hover card uses exactly the same frame as the Task card. */
export function agentHovercard(agents: readonly Subagent[], now: number): NodeJson | undefined {
  const node = agentWaitNode(agents, now, 'agent-hover')

  return node instanceof Node ? node.toJSON() : undefined
}

function agentTile(a: TileData, now: number): JSX.Element {
  const look = SUBAGENT_LOOK[a.status]

  return jobTile({
    actions: { click: `open-agent=${a.id}`, menu: [`open-agent=${a.id}`] },
    children: [
      a.tool ? <text key="figure" role="omp.job.tile.figure" spans={[{ t: a.tool }]} truncate="end" wrap="none" /> : null,
      ...a.lines.map((line, i) => <text key={`note-${i}`} role="omp.job.tile.note" spans={[{ s: 'dim', t: line }]} truncate="end" wrap="none" />)
    ],
    dot: { s: look.tone, t: '●', ...(a.status === 'running' ? { fx: 'pulse' } : {}) },
    hint: `${look.word} · Open ${a.name} beside the chat`,
    key: a.key,
    title: a.name,
    tone: look.tone,
    trailing: (
      <row align="center" gap="xs" key="age" role="hermes.agent.tile.age">
        <spinner key="spin" style="dots" tone={look.tone} />
        <elapsed age={Math.max(0, now - a.startedAt)} format="short" key="elapsed" />
      </row>
    )
  })
}
