// Tool Search's `tool_call` bridge, unpacked, and connectors told apart. With Tool Search on, the
// model reaches deferred tools through `tool_call {name, arguments}` and connectors (and MCP tools)
// through `tool_call {calls: [...]}`. Hermes unwraps a resolved local call before its events, but
// keeps the wrapper for a connector batch, for a call it refused, and in stored history. Here every
// call shows as the tool it ran; a batch keeps its entries. Names and titles follow Hermes'
// tools/tool_labels.py and tools/connectors/gateway/names.py.

import type { ToolCall } from './model.js'

const record = (v: unknown): Record<string, unknown> | undefined => {
  if (typeof v === 'string') {
    try {
      return record(JSON.parse(v))
    } catch {
      return undefined
    }
  }

  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

export const BRIDGE = 'tool_call'
/** Hermes' planner name for a connector batch (CONNECTOR_BATCH_SENTINEL). */
const BATCH = 'connectors__execute'

/** One call of a bridge batch, with its own outcome once the batch returns. */
export interface BatchEntry {
  name: string
  args: Record<string, unknown>
  status: ToolCall['status']
  /** The entry's `response`. */
  result?: unknown
  error?: string
}

/** A connector or MCP tool: the app it acts in and what it does there. */
export interface AppTool {
  kind: 'connector' | 'mcp'
  /** `Linear`, `Google Calendar`. */
  app: string
  /** `create issue`. */
  action: string
}

const TITLES: Record<string, string> = {
  discord: 'Discord',
  figma: 'Figma',
  github: 'GitHub',
  gmail: 'Gmail',
  googlecalendar: 'Google Calendar',
  googledocs: 'Google Docs',
  googledrive: 'Google Drive',
  jira: 'Jira',
  linear: 'Linear',
  notion: 'Notion',
  outlook: 'Outlook',
  slack: 'Slack',
  stripe_mcp: 'Stripe',
  todoist: 'Todoist'
}

/** Hermes' `app_title`: a known name, else the slug's words capitalized. */
export function appTitle(slug: string): string {
  const known = TITLES[slug.trim().toLowerCase()]

  if (known) {
    return known
  }

  const words = slug.split(/[-_\s]+/).filter(Boolean)

  // `granola_mcp` is Granola: the transport is not part of the app's name.
  if (words.length > 1 && words.at(-1)!.toLowerCase() === 'mcp') {
    words.pop()
  }

  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

/** Hermes' `_action_phrase`: the tool slug in words, without the app's own prefix. */
function actionPhrase(tool: string, app = ''): string {
  const prefix = `${app.replace(/-/g, '_').toUpperCase()}_`
  const text = app && tool.toUpperCase().startsWith(prefix) ? tool.slice(prefix.length) : tool

  return text.split(/[-_\s]+/).filter(Boolean).join(' ').toLowerCase()
}

/** `connectors__linear__LINEAR_CREATE_ISSUE` or `mcp__linear__create_issue` as an app and an action. */
export function appOf(name: string, args?: Record<string, unknown>): AppTool | undefined {
  // Hermes' parse_connector_name: `connectors__<connector>__<tool>`, the tool keeping any `__`.
  const [prefix, connector, ...tool] = name.split('__')

  if (prefix === 'connectors' && connector && tool.length && name !== BATCH) {
    const alias = typeof args?.connector_alias === 'string' && args.connector_alias.trim() ? ` (${args.connector_alias.trim()})` : ''

    return { action: actionPhrase(tool.join('__'), connector) + alias, app: appTitle(connector), kind: 'connector' }
  }

  const mcp = name.match(/^mcp__(.+?)__(.+)$/)

  return mcp ? { action: actionPhrase(mcp[2]!), app: appTitle(mcp[1]!), kind: 'mcp' } : undefined
}

/** The calls a bridge call asks for: `{name, arguments}` or `{calls: [{name, arguments}…]}`. */
function entriesOf(args: Record<string, unknown>): { name: string; args: Record<string, unknown> }[] {
  const list = Array.isArray(args.calls) ? args.calls : [args]

  return list.flatMap(e => {
    const r = record(e)
    const name = r?.name

    return typeof name === 'string' && name ? [{ args: record(r?.arguments) ?? {}, name }] : []
  })
}

/** What a bridge call is: the one tool it ran, or the batch of them. Other calls pass unchanged. */
export function unwrap(name: string, args: Record<string, unknown>): { name: string; args: Record<string, unknown>; via?: 'tool_call'; batch?: BatchEntry[] } {
  if (name !== BRIDGE && name !== BATCH) {
    return { args, name }
  }

  const entries = entriesOf(args)

  if (entries.length === 1) {
    return { ...entries[0]!, via: 'tool_call' }
  }

  return entries.length ? { args, batch: entries.map(e => ({ ...e, status: 'running' })), name, via: 'tool_call' } : { args, name }
}

/** A batch result (`{results: [{index, name, response | error}]}`) per entry, in call order. */
export function batchResults(result: unknown): { result?: unknown; error?: string }[] | undefined {
  const results = record(result)?.results

  if (!Array.isArray(results)) {
    return undefined
  }

  return results.map(e => {
    const r = record(e) ?? {}
    const err = r.error

    return err === undefined || err === null
      ? { result: r.response }
      : { error: typeof err === 'string' ? err : (String(record(err)?.message ?? '') || JSON.stringify(err)) }
  })
}

/**
 * A finished bridge call, folded onto `call`: a single connector call takes its entry's response
 * (or error) as its own; a batch gives each entry its outcome. True when the call failed.
 */
export function settleBridge(call: ToolCall): boolean | undefined {
  if (call.via !== 'tool_call') {
    return undefined
  }

  const outcomes = batchResults(call.result)

  if (!outcomes) {
    return undefined
  }

  if (call.batch) {
    call.batch.forEach((e, i) => {
      const o = outcomes[i]
      e.status = o?.error ? 'error' : 'done'
      e.result = o?.result
      e.error = o?.error
    })

    return call.batch.every(e => e.status === 'error')
  }

  const o = outcomes[0]
  call.result = o?.error ? { error: o.error } : o?.result

  return Boolean(o?.error)
}

/** The app a call acts in, for a batch the app all its entries share. */
export function callApp(call: Pick<ToolCall, 'args' | 'batch' | 'name'>): AppTool | undefined {
  if (call.batch) {
    const apps = call.batch.map(e => appOf(e.name, e.args))
    const first = apps[0]

    return first && apps.every(a => a?.app === first.app) ? { ...first, action: `${call.batch.length} calls` } : undefined
  }

  return appOf(call.name, call.args)
}
