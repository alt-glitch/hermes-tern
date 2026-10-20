// One parse per call: a tool call's args and result read once into its tool's detail, a variant
// keyed by `tool`. The views (view/tools/registry.ts) take the variant of their tool and read
// typed fields; none of them parses a result again. A call's parse is kept while its name, args
// and result stay the same objects; the transcript replaces them, never edits them in place.

import type { ToolCall } from '../model.js'
import { record } from '../wire/json.js'

import { type AskDetail, askDetail } from './ask.js'
import type { Raw } from './fields.js'
import { type EditDetail, editDetail, type ReadDetail, readDetail } from './files.js'
import {
  type EvalDetail,
  evalDetail,
  type MemoryDetail,
  memoryDetail,
  type PlainDetail,
  plainDetail,
  type ProcessDetail,
  processDetail,
  type PullRequestDetail,
  pullRequestDetail,
  type SkillDetail,
  skillDetail,
  type SkillsDetail,
  skillsDetail,
  type TodoDetail,
  todoDetail,
  type ToolDescribeDetail,
  toolDescribeDetail,
  type ToolSearchDetail,
  toolSearchDetail
} from './misc.js'
import { type SearchDetail, searchDetail } from './search.js'
import { type TaskDetail, taskDetail } from './task.js'
import { type TerminalDetail, terminalDetail } from './terminal.js'
import { type FetchDetail, fetchDetail, type WebSearchDetail, webSearchDetail } from './web.js'

/** A tool call's args and result, read: one variant per tool, `other` for a name none takes. */
export type ToolDetail =
  | AskDetail
  | EditDetail
  | EvalDetail
  | FetchDetail
  | MemoryDetail
  | PlainDetail
  | ProcessDetail
  | PullRequestDetail
  | ReadDetail
  | SearchDetail
  | SkillDetail
  | SkillsDetail
  | TaskDetail
  | TerminalDetail
  | TodoDetail
  | ToolDescribeDetail
  | ToolSearchDetail
  | WebSearchDetail

/** The tools with a detail (and a view) of their own. */
export type ToolKey = ToolDetail['tool']

/** The detail of tool `K`. */
export type DetailOf<K extends ToolKey> = Extract<ToolDetail, { tool: K }>

const PARSERS: { [K in ToolKey]: (raw: Raw) => DetailOf<K> } = {
  browser: plainDetail('browser'),
  clarify: askDetail,
  delegate_task: taskDetail,
  execute_code: evalDetail,
  image_generate: plainDetail('image_generate'),
  link_pull_request: pullRequestDetail('link_pull_request'),
  list_pull_requests: plainDetail('list_pull_requests'),
  manage_connections: plainDetail('manage_connections'),
  memory: memoryDetail,
  other: plainDetail('other'),
  patch: editDetail('patch'),
  process_manage: processDetail,
  read_file: readDetail,
  search_files: searchDetail,
  session_search: plainDetail('session_search'),
  skill_view: skillDetail,
  skills_list: skillsDetail,
  terminal: terminalDetail,
  todo_list: todoDetail,
  tool_describe: toolDescribeDetail,
  tool_search: toolSearchDetail,
  unlink_pull_request: pullRequestDetail('unlink_pull_request'),
  vision_analyze: plainDetail('vision_analyze'),
  web_extract: fetchDetail,
  web_search: webSearchDetail,
  write_file: editDetail('write_file')
}

/** The names a tool goes by besides its key: a legacy name stored transcripts and older backends keep. */
const ALIASES: ReadonlyMap<string, ToolKey> = new Map([
  ['process', 'process_manage'],
  ['todo', 'todo_list']
])

const KEYS: ReadonlySet<string> = new Set(Object.keys(PARSERS))

function isToolKey(name: string): name is ToolKey {
  return KEYS.has(name)
}

/**
 * The tool a call's name is: its own key, a legacy alias, `browser` for any `browser*` tool, and
 * `other` for a name no tool here takes.
 */
export function toolKeyOf(name: string): ToolKey {
  if (isToolKey(name)) {
    return name
  }

  return ALIASES.get(name) ?? (name.startsWith('browser') ? 'browser' : 'other')
}

interface Parsed {
  name: string
  args: unknown
  result: unknown
  /** The result as an object, its JSON text parsed. */
  record: Record<string, unknown> | undefined
  detail: ToolDetail
}

const parsed = new WeakMap<object, Parsed>()

type Readable = Pick<ToolCall, 'args' | 'name' | 'result'>

function parsedOf(call: Readable): Parsed {
  const hit = parsed.get(call)

  if (hit?.name === call.name && hit.args === call.args && hit.result === call.result) {
    return hit
  }

  const result = record(call.result)
  const fresh = { args: call.args, detail: PARSERS[toolKeyOf(call.name)]({ args: call.args, result }), name: call.name, record: result, result: call.result }
  parsed.set(call, fresh)

  return fresh
}

/** `call`'s detail, parsed on first read and again only when its name, args or result change. */
export function detailOf(call: Readable): ToolDetail {
  return parsedOf(call).detail
}

/** `call`'s result as an object (stored results are JSON text), from the same one parse. */
export function resultOf(call: Readable): Record<string, unknown> | undefined {
  return parsedOf(call).record
}
