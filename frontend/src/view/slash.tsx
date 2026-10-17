// Slash-command output: structured views for the answers worth drawing (`/usage`),
// Markdown for prose, and a monospace `ansi` block for output that is already laid out.

import type { JSX } from '@stencil-hq/tern'

import { hardBreaks, isPreformatted } from '../preformatted.js'
import { compactCount, type Crumb, type Pair, parseUsage, type RateLimit, type UsageSection } from '../usage.js'

import type { PanelEntry } from '../model.js'

const THRESHOLDS = { bad: 0.95, warn: 0.8 }

/** The body of a panel card: a structured view when the command has one, else Markdown or a mono block. */
export function slashBody(e: Pick<PanelEntry, 'text' | 'title'>): JSX.Element[] {
  if (/^\/usage\b/.test(e.title)) {
    const sections = parseUsage(e.text)

    if (sections) {
      return sections.map((s, i) => usageSection(s, i))
    }
  }

  return [textBody(e.text, 'body')]
}

/** One block of free text: aligned output stays monospace, anything else is Markdown. */
function textBody(text: string, key: string): JSX.Element {
  return isPreformatted(text) ? <ansi key={key} text={text} /> : <md key={key}>{hardBreaks(text)}</md>
}

function heading(icon: string, title: string, note?: string): JSX.Element {
  return (
    <row align="center" gap="xs" key="head">
      <icon key="icon" name={icon} />
      <text key="title" spans={[{ s: 'strong', t: title }, ...(note ? [{ s: 'dim', t: `  ${note}` }] : [])]} />
    </row>
  )
}

function usageSection(s: UsageSection, i: number): JSX.Element {
  const key = `s${i}`

  switch (s.kind) {
    case 'limits':
      return (
        <col gap="xs" key={key}>
          {heading('gauge', s.title)}
          {limitsTable(s.items)}
        </col>
      )

    case 'session':
      return (
        <col gap="xs" key={key}>
          {heading('tokens', s.title)}
          {sessionBody(s.rows, s.context)}
        </col>
      )

    case 'breakdown':
      return (
        <col gap="xs" key={key}>
          {heading('stack', s.title, s.note)}
          {breakdownBody(s.items)}
        </col>
      )

    case 'credits':
      return (
        <col gap="xs" key={key}>
          {heading('cost', s.title)}
          {pairTable(s.rows, 'credits')}
          {s.notes.map((n, j) => (
            <text key={`note${j}`} spans={[{ s: 'dim', t: n }]} />
          ))}
        </col>
      )

    case 'text':
      return (
        <col gap="xs" key={key}>
          {s.title ? heading('info', s.title) : null}
          {textBody(s.text, 'text')}
        </col>
      )
  }
}

/** One meter per limit, filled with the share used: warning from 80%, error from 95%. */
function limitsTable(items: RateLimit[]): JSX.Element {
  return (
    <table
      cols={[
        { id: 'name' },
        { grow: 1, id: 'bar' },
        { align: 'end', id: 'left' },
        { align: 'end', id: 'reset' }
      ]}
      key="limits"
      rows={items.map(l => {
        const used = Math.min(1, Math.max(0, (l.limit - l.left) / l.limit))

        return {
          cells: {
            bar: {
              meter: {
                thresholds: THRESHOLDS,
                title: `${l.left.toLocaleString()} of ${l.limit.toLocaleString()} left`,
                value: used
              }
            },
            left: [{ s: 'num', t: `${compactCount(l.left)} / ${compactCount(l.limit)}` }],
            name: [{ s: 'muted mono', t: l.name }],
            reset: [{ s: 'dim', t: l.reset ? `resets ${l.reset}` : '' }]
          },
          id: l.name
        }
      })}
    />
  )
}

function sessionBody(rows: Pair[], context?: { used: number; max: number }): JSX.Element[] {
  const model = rows.find(r => /^model$/i.test(r.key))
  const rest = rows.filter(r => r !== model)
  const out: JSX.Element[] = []

  if (model) {
    out.push(
      <row align="center" gap="sm" key="model">
        <text key="k" spans={[{ s: 'muted', t: 'Model' }]} />
        <badge key="v" text={model.value} />
      </row>
    )
  }

  if (rest.length) {
    out.push(pairTable(rest, 'session'))
  }

  if (context) {
    const share = Math.min(1, context.used / context.max)

    out.push(
      <table
        cols={[{ id: 'k' }, { grow: 1, id: 'bar' }, { align: 'end', id: 'v' }]}
        key="context"
        rows={[
          {
            cells: {
              bar: {
                meter: {
                  thresholds: { bad: 0.85, warn: 0.6 },
                  title: `${context.used.toLocaleString()} of ${context.max.toLocaleString()} tokens (${Math.round(share * 100)}%)`,
                  value: share
                }
              },
              k: [{ s: 'muted', t: 'Context' }],
              v: [{ s: 'num', t: `${compactCount(context.used)} / ${compactCount(context.max)}` }]
            },
            id: 'context'
          }
        ]}
      />
    )
  }

  return out
}

/** Keys muted at the left, values right-aligned; a URL value becomes a link. */
function pairTable(rows: Pair[], id: string): JSX.Element {
  return (
    <table
      cols={[
        { id: 'k', truncate: 'end' },
        { align: 'end', id: 'v', grow: 1 }
      ]}
      key={id}
      rows={rows.map((r, i) => ({
        cells: {
          k: [{ s: 'muted', t: r.key }],
          v: /^https?:\/\//.test(r.value)
            ? [{ href: r.value, s: 'link', t: r.value }]
            : [{ s: /^[\d$,.%\s-]+$/.test(r.value) ? 'num' : '', t: r.value }]
        },
        id: `${id}${i}`
      }))}
    />
  )
}

/** The biggest parts first, each with its share as a small meter. */
function breakdownBody(items: Crumb[]): JSX.Element[] {
  const sorted = [...items].sort((a, b) => b.tokens - a.tokens)
  const total = sorted.reduce((n, c) => n + c.tokens, 0)

  return [
    <table
      cols={[
        { id: 'name', truncate: 'end' },
        { align: 'end', id: 'tokens' },
        { align: 'end', id: 'share', grow: 1 }
      ]}
      key="list"
      rows={sorted.map((c, i) => ({
        cells: {
          name: [{ s: 'muted', t: c.label }],
          share: { meter: { value: c.tokens / total } },
          tokens: [{ s: 'num', t: `~${compactCount(c.tokens)}${c.pct === undefined ? '' : ` (${c.pct}%)`}` }]
        },
        id: `b${i}`
      }))}
    />
  ]
}
