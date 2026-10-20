// The tool registry (view/tools/registry.ts) and the one parse per call (tools/detail.ts). Every
// fixture call's step line, action and icon, and the agents hub's icons, are the strings the four
// name switches gave before the registry took their place; the cards each call draws are a file
// snapshot.
import { describe, expect, it } from 'vitest'

import { detailOf, resultOf, toolKeyOf } from '../tools/detail.js'
import { hubIconOf } from '../view/tools/registry.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { actionIcon, actionOf, groupIcon, stepLabel, summarize, type WorkItem } from '../workLog.js'

import { call, fixtureCalls } from './toolFixtures.js'

/** Each fixture call's name, step line, action and icon, in fixtureCalls() order. */
const STEPS = [
['terminal', 'ls -la', 'command', 'terminal'],
  ['terminal', 'npm test', 'command', 'terminal'],
  ['terminal', 'Command', 'command', 'terminal'],
  ['terminal', 'cat a | head', 'command', 'terminal'],
  ['terminal', 'for f in *; do echo "$f" done', 'command', 'terminal'],
  ['terminal', 'npm run dev', 'command', 'terminal'],
  ['terminal', 'sleep 99', 'command', 'terminal'],
  ['terminal', 'make', 'command', 'terminal'],
  ['read_file', 'Read src/a.ts', 'read', 'eye'],
  ['read_file', 'Read src/b.ts', 'read', 'eye'],
  ['read_file', 'Read file', 'read', 'eye'],
  ['read_file', 'Read file', 'read', 'eye'],
  ['patch', 'Edited src/a.ts', 'edit', 'pencil'],
  ['patch', 'Edited a file', 'edit', 'pencil'],
  ['write_file', 'Wrote docs/new.md', 'edit', 'pencil'],
  ['write_file', 'Wrote a file', 'edit', 'pencil'],
  ['search_files', 'Searched def  in lab', 'code-search', 'search'],
  ['search_files', 'Searched files *.md', 'code-search', 'search'],
  ['search_files', 'Searched TODO', 'code-search', 'search'],
  ['web_search', 'Searched the web for tern terminal', 'search', 'globe'],
  ['web_search', 'Searched the web for old shape', 'search', 'globe'],
  ['web_search', 'Web search', 'search', 'globe'],
  ['web_extract', 'Read https://a.io +1 more', 'fetch', 'globe'],
  ['web_extract', 'Read https://c.io', 'fetch', 'globe'],
  ['web_extract', 'Read a page', 'fetch', 'globe'],
  ['web_extract', 'Read a page', 'fetch', 'globe'],
  ['execute_code', 'print(1)', 'command', 'terminal'],
  ['execute_code', 'Ran a script', 'command', 'terminal'],
  ['link_pull_request', 'Linked o/r#12', 'other', 'wrench'],
  ['link_pull_request', 'Linked o/r#3', 'other', 'wrench'],
  ['unlink_pull_request', 'Unlinked a pull request', 'other', 'wrench'],
  ['list_pull_requests', 'Listed linked pull requests', 'other', 'wrench'],
  ['skill_view', 'Read skill composio', 'other', 'wrench'],
  ['skill_view', 'Read a skill', 'other', 'wrench'],
  ['skills_list', 'Listed skills', 'other', 'wrench'],
  ['skills_list', 'Listed skills', 'other', 'wrench'],
  ['tool_search', 'Searched tools for linear, ', 'lookup', 'search'],
  ['tool_search', 'Searched tools for slack', 'lookup', 'search'],
  ['tool_search', 'Searched tools', 'lookup', 'search'],
  ['tool_describe', 'Read how to call Granola · list meetings, cronjob manage', 'lookup', 'search'],
  ['tool_describe', 'Read how to call Linear · create issue', 'lookup', 'search'],
  ['tool_describe', 'Read tool details', 'lookup', 'search'],
  ['todo', 'Planned 2 steps', 'plan', 'list-checks'],
  ['todo_list', 'Plan updated: ✓ Write tests, + Run the suite', 'plan', 'list-checks'],
  ['delegate_task', 'Delegate task: audit', 'other', 'wrench'],
  ['delegate_task', 'Delegate task', 'other', 'wrench'],
  ['delegate_task', 'Delegate task', 'other', 'wrench'],
  ['clarify', 'Clarify', 'other', 'wrench'],
  ['clarify', 'Clarify', 'other', 'wrench'],
  ['memory', 'Memory: add: likes tabs', 'other', 'wrench'],
  ['process', 'Process', 'command', 'terminal'],
  ['process_manage', 'Process manage', 'command', 'terminal'],
  ['process_manage', 'Process manage', 'command', 'terminal'],
  ['browser_navigate', 'Browser navigate', 'browser', 'compass'],
  ['browser_vision', 'Browser vision', 'browser', 'compass'],
  ['browser', 'Browser: open', 'browser', 'compass'],
  ['session_search', 'Session search', 'other', 'wrench'],
  ['vision_analyze', 'Vision analyze', 'other', 'wrench'],
  ['image_generate', 'Image generate', 'other', 'wrench'],
  ['image_generate', 'Image generate', 'other', 'wrench'],
  ['manage_connections', 'Manage connections', 'other', 'wrench'],
  ['manage_connections', 'Manage connections', 'other', 'wrench'],
  ['unknown_tool', 'Unknown tool: something on two lines', 'other', 'wrench'],
  ['weird-name', 'Weird-name', 'other', 'wrench'],
  ['other', 'Other', 'other', 'wrench'],
  ['connectors__linear__LINEAR_CREATE_ISSUE', 'Linear · create issue (work)', 'app', 'plug'],
  ['mcp__slack__send_message', 'Slack · send message', 'app', 'plug'],
  ['tool_call', 'Linear · create issue, Slack · send message', 'app', 'plug'],
  ['tool_call', 'Linear · create issue, Read file', 'other', 'wrench'],
  ['tool_call', 'Linear · 2 calls', 'app', 'plug']
]

const items = (): WorkItem[] => fixtureCalls().map(c => ({ call: c, id: c.id, kind: 'tool' }))

describe('the tool registry', () => {
  it('gives every call the step line, action and icon it had', () => {
    expect(fixtureCalls().map(c => [c.name, stepLabel(c), actionOf(c), actionIcon(actionOf(c))])).toEqual(STEPS)
  })

  it('summarizes a group as before', () => {
    expect([summarize(items()), groupIcon(items()), summarize(items().slice(0, 10)), groupIcon(items().slice(0, 8))]).toEqual([
      'Ran 13 commands, changed 4 files, and performed 53 other actions',
      'hammer',
      'Ran 8 commands and read 2 files',
      'terminal'
    ])
  })

  it('keeps the agents hub icons: read_file stays read', () => {
    const names = [
      'browser_navigate',
      'browser_vision',
      'connectors__linear__LINEAR_CREATE_ISSUE',
      'execute_code',
      'patch',
      'process',
      'read_file',
      'search_files',
      'terminal',
      'todo',
      'unknown_tool',
      'web_extract',
      'web_search',
      'write_file'
    ]

    expect(Object.fromEntries(names.map(n => [n, hubIconOf(n)]))).toEqual({
      browser_navigate: 'web',
      browser_vision: 'wrench',
      connectors__linear__LINEAR_CREATE_ISSUE: 'wrench',
      execute_code: 'python',
      patch: 'edit',
      process: 'wrench',
      read_file: 'read',
      search_files: 'search',
      terminal: 'bash',
      todo: 'wrench',
      unknown_tool: 'wrench',
      web_extract: 'web',
      web_search: 'web',
      write_file: 'write'
    })
  })

  it('draws every call as before', async () => {
    const cards = fixtureCalls().map(c => ({ detail: toolDetail(c, 5_000), name: c.name, node: toolNode(c, 5_000) }))

    await expect(`${JSON.stringify(cards, null, 1)}\n`).toMatchFileSnapshot('__snapshots__/toolRegistry/cards.json')
  })
})

describe('tool details', () => {
  it('names a tool by its key, a legacy alias, the browser family or other', () => {
    expect(['terminal', 'todo', 'process', 'browser_navigate', 'browser', 'manage_connections', 'nope'].map(toolKeyOf)).toEqual([
      'terminal',
      'todo_list',
      'process_manage',
      'browser',
      'browser',
      'manage_connections',
      'other'
    ])
  })

  it('reads a stored result once, and again only when the result changes', () => {
    const c = call('read_file', { path: 'a.ts' }, { result: JSON.stringify({ content: '   1|x', total_lines: 1 }) })
    const first = detailOf(c)

    expect(first).toEqual({ content: '   1|x', path: 'a.ts', tool: 'read_file', totalLines: 1 })
    expect(detailOf(c)).toBe(first)
    expect(resultOf(c)).toBe(resultOf(c))

    c.result = { content: '   1|y', total_lines: 1 }
    expect(detailOf(c)).toMatchObject({ content: '   1|y' })

    c.args = { path: 'b.ts' }
    expect(detailOf(c)).toMatchObject({ path: 'b.ts' })
  })

  it('reads past fields of the wrong type', () => {
    expect(detailOf(call('search_files', { path: 3, pattern: ['x'] }, { result: { files: 'no', matches: [7, { line: 'two' }] } }))).toEqual({
      files: undefined,
      filesOnly: false,
      matches: [{ line: 0, path: '', text: '' }],
      path: undefined,
      pattern: undefined,
      tool: 'search_files',
      total: undefined
    })
  })
})
