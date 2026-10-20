// The file tools' details: read_file's lines, and the change patch or write_file made.

import { num, type Raw, text } from './fields.js'

/** A `read_file` call, read once. */
export interface ReadDetail {
  tool: 'read_file'
  path: string | undefined
  /** The lines read, each prefixed with its number (`  12|`). */
  content: string | undefined
  /** How many lines the whole file has. */
  totalLines: number | undefined
}

interface EditFields {
  path: string | undefined
  /** The text write_file wrote. */
  content: string | undefined
  /** The unified diff the result carries. */
  diff: string | undefined
}

/** A `patch` or `write_file` call, read once. */
export type EditDetail = (EditFields & { tool: 'patch' }) | (EditFields & { tool: 'write_file' })

export function readDetail({ args, result }: Raw): ReadDetail {
  return {
    content: text(result?.['content']),
    path: text(args['path']),
    tool: 'read_file',
    totalLines: num(result?.['total_lines'])
  }
}

/** The parser of `patch` or `write_file`: the same fields, under either key. */
export function editDetail<T extends EditDetail['tool']>(tool: T): (raw: Raw) => EditFields & { tool: T } {
  return ({ args, result }) => ({ content: text(args['content']), diff: text(result?.['diff']), path: text(args['path']), tool })
}
