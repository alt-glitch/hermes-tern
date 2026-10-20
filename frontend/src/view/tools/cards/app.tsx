// Connector and MCP calls: the app a call acted in heads its card; a batch lists each entry.

import type { JSX } from '@stencil-hq/tern'

import type { NonEmpty } from '../../../core/assert.js'
import { clip } from '../../../core/text.js'
import type { ToolCall } from '../../../model.js'
import { appOf, type AppTool, appsOf, type BatchEntry } from '../../../tools/bridge.js'
import type { Card } from '../types.js'

import { errorOf, genericBody, humanize, pretty } from './generic.js'

/** A connector or MCP tool: the app it acted in heads the card, its arguments and answer below. */
export function appCard(call: ToolCall, app: AppTool): Card {
  return {
    badges: [{ text: app.kind === 'mcp' ? 'MCP' : 'connector' }],
    body: call.via.kind === 'batch' ? batchBody(call, call.via.entries) : appBody(call),
    folded: true,
    frame: 'inline',
    name: 'plug',
    target: app.action,
    targetKind: 'text',
    title: app.app
  }
}

/** A batch of tool calls with no one app: the apps it reached head it, one line per entry below. */
export function batchCard(call: ToolCall, batch: NonEmpty<BatchEntry>): Card {
  const apps = appsOf(call)

  return {
    badges: apps.length ? [{ text: 'connectors' }] : undefined,
    body: batchBody(call, batch),
    folded: true,
    frame: 'inline',
    name: 'plug',
    target: `${batch.length} calls`,
    targetKind: 'text',
    title: apps.length ? apps.join(', ') : 'Tool calls'
  }
}

/** A connector call: what it was asked (as facts), then what it answered. */
function appBody(call: ToolCall): JSX.Element[] {
  const facts = Object.entries(call.args)
    .filter(([k, v]) => k !== 'connector_alias' && v !== undefined && v !== null && v !== '')
    .slice(0, 12)
    .map(([k, v]) => ({ k: [{ t: k.replace(/_/g, ' ') }], v: clip(typeof v === 'string' ? v : JSON.stringify(v), { mark: 'line', max: 300 }) }))

  const error = call.outcome.kind === 'error' ? errorOf(call) : undefined

  return [
    ...(facts.length ? [<kv items={facts} key="args" />] : []),
    ...(error ? [<text key="error" spans={[{ s: 'error', t: clip(error, { mark: 'line', max: 1200 }) }]} wrap="word" />] : genericBody(call))
  ]
}

/** A batch: one line per entry with its outcome, then each answer. */
function batchBody(call: ToolCall, batch: readonly BatchEntry[]): JSX.Element[] {
  return batch.flatMap(({ args, name, outcome }, i) => {
    const app = appOf(name, args)
    const tone = outcome.kind === 'error' ? 'error' : outcome.kind === 'running' ? 'pending' : 'success'
    const error = outcome.kind === 'error' ? outcome.error : undefined
    const answer = error ?? (outcome.kind !== 'done' || outcome.result === undefined ? undefined : pretty(outcome.result))

    return [
      <row align="center" gap="sm" key={`e${i}`}>
        <icon key="i" name={outcome.kind === 'error' ? 'x' : outcome.kind === 'running' ? 'clock' : 'check'} tone={tone} />
        <text grow={1} key="t" spans={[{ t: app ? `${app.app} · ${app.action}` : humanize(name) }]} truncate="end" wrap="none" />
      </row>,
      ...(error
        ? [<text key={`r${i}`} spans={[{ s: 'error', t: clip(error, { mark: 'line', max: 600 }) }]} wrap="word" />]
        : answer && call.outcome.kind !== 'running'
          ? [<code key={`r${i}`} lang={/^\s*[[{]/.test(answer) ? 'json' : 'text'} max={{ h: '8lines' }} text={clip(answer, { mark: 'line', max: 2000 })} wrap />]
          : [])
    ]
  })
}
