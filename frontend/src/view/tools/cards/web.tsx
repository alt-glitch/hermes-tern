// The web_search and web_extract tools: omp's web_search card (sources) and fetch card (pages).

import type { JSX } from '@stencil-hq/tern'

import { clip, plural } from '../../../core/text.js'
import type { ToolCall } from '../../../model.js'
import type { FetchDetail, WebSearchDetail } from '../../../tools/web.js'
import { compact } from '../../time.js'
import type { Card, ToolView } from '../types.js'

/** The web_search tool's view. */
export const webSearchView: ToolView<'web_search'> = {
  action: 'search',
  card: webSearchCard,
  hubIcon: 'web',
  step: (_call, d) => (d.query ? `Searched the web for ${d.query}` : 'Web search')
}

/** The web_extract tool's view: its step names the first page and counts the rest. */
export const fetchView: ToolView<'web_extract'> = {
  action: 'fetch',
  card: fetchCard,
  hubIcon: 'web',
  step: (_call, d) => {
    const first = d.urls[0] ?? d.url

    return first ? `Read ${first}${d.urls.length > 1 ? ` +${d.urls.length - 1} more` : ''}` : 'Read a page'
  }
}

/** A web search as the sources it found, each linked; framed once they are in. */
function webSearchCard(call: ToolCall, d: WebSearchDetail): Card {
  const hits = d.hits

  return {
    body: hits.length
      ? [
          <col key="s" role="omp.tool.sources">
            {hits.map((h, i) => sourceRow(`s${i}`, h.title ?? h.url ?? '', h.url))}
          </col>
        ]
      : [],
    frame: 'inline',
    framedWithBody: true,
    meta: hits.length ? [plural(hits.length, 'source')] : undefined,
    name: 'web_search',
    target: d.query ?? call.context,
    targetKind: 'query',
    title: 'Web search'
  }
}

/** A page fetch: each page as its linked source and its content. */
function fetchCard(call: ToolCall, d: FetchDetail): Card {
  const pages = d.pages
  const urls = d.urls.filter(u => u !== '')
  const body: JSX.Element[] = []

  for (const [i, p] of pages.entries()) {
    body.push(sourceRow(`s${i}`, p.title ?? p.url ?? '', p.url))
    const content = p.content

    if (content) {
      body.push(<md key={`b${i}`}>{clip(content, { mark: 'line', max: 4000 })}</md>)
    }
  }

  const chars = pages.reduce((n, p) => n + (p.content?.length ?? 0), 0)

  return {
    body,
    folded: true,
    meta: pages.length ? [`${plural(pages.length, 'page')} · ${compact(chars)} chars`] : undefined,
    name: 'fetch',
    preview: { lines: 6 },
    target: urls.length > 1 ? `${urls[0]} +${urls.length - 1}` : (urls[0] ?? d.url ?? call.context),
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
