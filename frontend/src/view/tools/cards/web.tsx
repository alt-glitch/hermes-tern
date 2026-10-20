// The web_search and web_extract tools: omp's web_search card (sources) and fetch card (pages).

import type { JSX } from '@stencil-hq/tern'

import type { ToolCall } from '../../../model.js'
import { record } from '../../../wire/json.js'
import { clip, nonEmpty, plural } from '../../format.js'
import { compact } from '../../time.js'
import type { Card } from '../types.js'

/** A web search as the sources it found, each linked. */
export function webSearchCard(call: ToolCall, result: Record<string, unknown> | undefined): Card {
  const data = record(result?.data)

  const hits = (Array.isArray(data?.web) ? data.web : Array.isArray(result?.results) ? result.results : [])
    .map(h => record(h))
    .filter(h => h !== undefined)

  return {
    body: hits.length
      ? [
          <col key="s" role="omp.tool.sources">
            {hits.map((h, i) => sourceRow(`s${i}`, nonEmpty(h.title) ?? nonEmpty(h.url) ?? '', nonEmpty(h.url)))}
          </col>
        ]
      : [],
    frame: 'inline',
    meta: hits.length ? [plural(hits.length, 'source')] : undefined,
    name: 'web_search',
    target: nonEmpty(call.args.query) ?? call.context,
    targetKind: 'query',
    title: 'Web search'
  }
}

/** A page fetch: each page as its linked source and its content. */
export function fetchCard(call: ToolCall, result: Record<string, unknown> | undefined): Card {
  const pages = (Array.isArray(result?.results) ? result.results : []).map(p => record(p)).filter(p => p !== undefined)
  const urls = Array.isArray(call.args.urls) ? call.args.urls.map(u => nonEmpty(u)).filter(u => u !== undefined) : []
  const body: JSX.Element[] = []

  for (const [i, p] of pages.entries()) {
    body.push(sourceRow(`s${i}`, nonEmpty(p.title) ?? nonEmpty(p.url) ?? '', nonEmpty(p.url)))
    const content = nonEmpty(p.content)

    if (content) {
      body.push(<md key={`b${i}`}>{clip(content, { mark: 'line', max: 4000 })}</md>)
    }
  }

  const chars = pages.reduce((n, p) => n + (nonEmpty(p.content)?.length ?? 0), 0)

  return {
    body,
    folded: true,
    meta: pages.length ? [`${plural(pages.length, 'page')} · ${compact(chars)} chars`] : undefined,
    name: 'fetch',
    preview: { lines: 6 },
    target: urls.length > 1 ? `${urls[0]} +${urls.length - 1}` : (urls[0] ?? nonEmpty(call.args.url) ?? call.context),
    targetKind: 'path',
    title: 'Fetch'
  }
}

/** One linked source: a domain-initial chip, the linked title, the muted domain. */
function sourceRow(key: string, title: string, url: string | undefined): JSX.Element {
  let host = ''

  try {
    host = url ? new URL(url).hostname.replace(/^www\./, '') : ''
  } catch {
    host = ''
  }

  return (
    <row key={key} role="omp.tool.source">
      <text key="d" role="omp.tool.chip" spans={[{ t: (host.charAt(0) || '·').toUpperCase() }]} />
      <text key="t" spans={[url ? { href: url, t: title } : { t: title }]} />
      {host ? <text key="m" spans={[{ s: 'muted', t: host }]} /> : null}
    </row>
  )
}
