// The web tools' details: web_search's sources and web_extract's pages.

import { record } from '../wire/json.js'

import { list, objects, type Raw, text } from './fields.js'

/** A source a search found or a page a fetch read. */
export interface Source {
  title: string | undefined
  url: string | undefined
  /** A fetched page's text. */
  content: string | undefined
}

/** A `web_search` call, read once. */
export interface WebSearchDetail {
  tool: 'web_search'
  query: string | undefined
  /** The sources found: the result's `data.web`, or its `results`. */
  hits: Source[]
}

/** A `web_extract` call, read once. */
export interface FetchDetail {
  tool: 'web_extract'
  /** Every string in the args' `urls`, empty ones kept (the step line and the card read them differently). */
  urls: string[]
  /** The single `url` older calls give. */
  url: string | undefined
  pages: Source[]
}

function source(r: Record<string, unknown>): Source {
  return { content: text(r['content']), title: text(r['title']), url: text(r['url']) }
}

export function webSearchDetail({ args, result }: Raw): WebSearchDetail {
  const web = list(record(result?.['data'])?.['web'])

  return { hits: objects(web ?? result?.['results']).map(source), query: text(args['query']), tool: 'web_search' }
}

export function fetchDetail({ args, result }: Raw): FetchDetail {
  return {
    pages: objects(result?.['results']).map(source),
    tool: 'web_extract',
    url: text(args['url']),
    urls: (list(args['urls']) ?? []).filter(u => typeof u === 'string')
  }
}
