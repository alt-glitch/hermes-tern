// The search_files tool's detail: what it looked for, where, and the files or lines it found.

import { list, num, objects, type Raw, text, texts } from './fields.js'

/** One matching line of a content search. */
export interface SearchMatch {
  /** The file, as the tool wrote it (empty when it named none). */
  path: string
  /** Its line number; 0 when the match names none. */
  line: number
  text: string
}

/** A `search_files` call, read once. */
export interface SearchDetail {
  tool: 'search_files'
  pattern: string | undefined
  /** The folder searched. */
  path: string | undefined
  /** Asked for file names (`target: 'files'`), not lines. */
  filesOnly: boolean
  /** The files a file search found; undefined when the result lists none. */
  files: string[] | undefined
  /** The lines a content search found; undefined when the result lists none. */
  matches: SearchMatch[] | undefined
  /** The total the tool counted, which may pass what it listed. */
  total: number | undefined
}

export function searchDetail({ args, result }: Raw): SearchDetail {
  const matches = list(result?.['matches'])

  return {
    files: list(result?.['files']) ? texts(result?.['files']) : undefined,
    filesOnly: args['target'] === 'files',
    matches: matches
      ? objects(matches).map(m => ({
          line: num(m['line']) ?? 0,
          path: text(m['path']) ?? '',
          text: typeof m['content'] === 'string' ? m['content'] : ''
        }))
      : undefined,
    path: text(args['path']),
    pattern: text(args['pattern']),
    tool: 'search_files',
    total: num(result?.['total_count'])
  }
}
