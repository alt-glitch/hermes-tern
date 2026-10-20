// Tool calls of every tool the views know, with the arg and result shapes each reads (and some
// they must read past): the registry test checks each call's step line, action and icon.

import type { BatchEntry } from '../bridge.js'
import { toolCallId } from '../core/ids.js'
import type { ToolCall } from '../model.js'

let n = 0

/** A settled call of tool `name`; `more` sets its result, status, context and the rest. */
export function call(name: string, args: Record<string, unknown> = {}, more: Partial<ToolCall> = {}): ToolCall {
  return { args, argsText: '', context: '', id: toolCallId(`f${++n}`), name, outcome: { duration: 1_200, kind: 'done' }, startedAt: 1_000, via: { kind: 'direct' }, ...more }
}

const todos = [
  { content: 'Write tests', id: '1', status: 'completed' as const },
  { content: 'Run the suite', id: '2', status: 'in_progress' as const }
]

const entry = (name: string, i: number): BatchEntry => ({ args: { title: `t${i}` }, name, outcome: { kind: 'done', result: { ok: i } } })

const batch = (first: string, ...names: string[]): Pick<ToolCall, 'via'> => ({
  via: { entries: [entry(first, 0), ...names.map((name, i) => entry(name, i + 1))], kind: 'batch' }
})

/** Every fixture call, built fresh. */
export function fixtureCalls(): ToolCall[] {
  n = 0

  return [
    call('terminal', { command: 'ls -la' }, { result: { exit_code: 0, output: 'a\nb\n' } }),
    call('terminal', {}, { context: 'npm test' }),
    call('terminal', {}),
    call('terminal', { command: "sh -c 'cat a\n  | head'" }, { result: JSON.stringify({ exit_code: 2, output: 'oops' }), outcome: { duration: 1_200, kind: 'error' } }),
    call('terminal', { command: 'for f in *; do\n  echo "$f"\ndone' }, { result: { error: 'no such file', exit_code: 1 } }),
    call('terminal', { background: true, command: 'npm run dev' }, { result: { session_id: 'proc_1' } }),
    call('terminal', { command: 'sleep 99' }, { result: { session_id: 'proc_2' }, outcome: { kind: 'running' } }),
    call('terminal', { command: 'make' }, { outcome: { duration: 1_200, kind: 'cancelled' } }),
    call('read_file', { path: 'src/a.ts' }, { result: { content: '   1|const a = 1\n   2|export {}', total_lines: 2 } }),
    call('read_file', { path: 'src/b.ts' }, { result: JSON.stringify({ content: '  10|x\n  11|y', total_lines: 40 }) }),
    call('read_file', {}, { context: 'notes.md' }),
    call('read_file', { path: 7 }, { result: { error: 'denied' }, outcome: { duration: 1_200, kind: 'error' } }),
    call('patch', { path: 'src/a.ts' }, { result: { diff: '--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b' } }),
    call('patch', {}, { diff: '-x\n+y' }),
    call('write_file', { content: 'hello\nworld\n', path: 'docs/new.md' }, { result: { diff: '@@ -0,0 +1,2 @@\n+hello\n+world' } }),
    call('write_file', { content: 'x' }),
    call('search_files', { path: 'lab', pattern: 'def ' }, { result: { matches: [{ content: 'def a', line: 3, path: './lab/x.py' }, { content: 'def b', line: 4, path: 'lab/x.py' }, 'junk'], total_count: 2 } }),
    call('search_files', { path: '.', pattern: '*.md', target: 'files' }, { result: { files: ['./README.md', '', 3, 'docs/a.md'], total_count: 9 } }),
    call('search_files', {}, { context: 'TODO' }),
    call('web_search', { query: 'tern terminal' }, { result: { data: { web: [{ title: 'Tern', url: 'https://www.tern.dev/x' }, { url: 'https://b.io' }] } } }),
    call('web_search', { query: 'old shape' }, { result: { results: [{ title: 'Old', url: 'notaurl' }] } }),
    call('web_search', {}),
    call('web_extract', { urls: ['https://a.io', 'https://b.io'] }, { result: { results: [{ content: 'page a', title: 'A', url: 'https://a.io' }, { url: 'https://b.io' }] } }),
    call('web_extract', { url: 'https://c.io' }),
    call('web_extract', { urls: ['', 'https://d.io'] }),
    call('web_extract', {}),
    call('execute_code', { code: '# Sum\nprint(1)' }, { context: 'print(1)\n', result: { output: '1\n' } }),
    call('execute_code', { code: 'x' }, { result: { stderr: 'boom' }, outcome: { duration: 1_200, kind: 'error' } }),
    call('link_pull_request', { url: 'https://github.com/o/r/pull/12' }),
    call('link_pull_request', { number: 3, repository: 'o/r' }),
    call('unlink_pull_request', {}),
    call('list_pull_requests'),
    call('skill_view', { name: 'composio' }, { result: { content: '# Composio' } }),
    call('skill_view'),
    call('skills_list', {}, { result: { skills: [{ name: 'a' }, 'b', 3] } }),
    call('skills_list', {}, { result: { message: 'none here', skills: [] } }),
    call('tool_search', { queries: ['linear', 2, ''] }),
    call('tool_search', { query: 'slack' }),
    call('tool_search'),
    call('tool_describe', { names: ['connectors__granola_mcp__LIST_MEETINGS', 'cronjob_manage'] }),
    call('tool_describe', { names: 'mcp__linear__create_issue' }),
    call('tool_describe'),
    call('todo', { todos }, { todos }),
    call('todo_list', { todos }, { todos, todosBefore: [{ content: 'Write tests', id: '1', status: 'pending' }] }),
    call('delegate_task', { goal: 'Audit the repo' }, { context: 'audit', result: { results: [{ status: 'ok', summary: 'all clear' }] } }),
    call('delegate_task', { context: 'shared', tasks: [{ goal: 'g1' }, 'x', { context: 'own', goal: 'g2' }] }, { result: { mode: 'background', status: 'dispatched' } }),
    call('delegate_task', { tasks: [{ goal: 'g1' }] }, { result: { error: 'no model' }, outcome: { duration: 1_200, kind: 'error' } }),
    call('clarify', { choices: ['a', 'b'], question: 'Pick?' }, { result: { responses: [{ user_response: 'b' }] } }),
    call('clarify', { questions: [{ question: 'One?' }, { choices: ['x'], question: 'Two?' }] }, { result: { responses: [null, { status: 'skipped' }] } }),
    call('memory', { action: 'add' }, { context: 'add: likes tabs', result: { usage: '12% full' } }),
    call('process', { action: 'wait', session_id: 'proc_1' }),
    call('process_manage', { action: 'kill', session_id: 'proc_1' }),
    call('process_manage', {}),
    call('browser_navigate', { url: 'https://tern.dev' }),
    call('browser_vision', { question: 'what?' }, { result: { meta: { screenshot_path: '/tmp/shot.png' }, text_summary: 'A page' } }),
    call('browser', {}, { context: 'open' }),
    call('session_search', { query: 'last week' }),
    call('vision_analyze', { question: 'what?' }, { result: { analysis: 'A chart.', success: true } }),
    call('image_generate', { prompt: 'a red fox' }, { result: { image: '/h/fox.png', success: true } }),
    call('image_generate', { prompt: 'pending' }, { outcome: { kind: 'running' } }),
    call('manage_connections', { action: 'connect' }, { result: { targets: [{ connect_url: 'https://auth/l', name: 'linear', state: 'initiated' }] } }),
    call('manage_connections', { action: 'status' }, { result: { targets: [{ name: 'linear', state: 'connected' }] } }),
    call('unknown_tool', { url: 'https://x.io' }, { context: 'something\n  on two lines' }),
    call('weird-name', { query: 'q' }, { result: 'plain text result' }),
    call('other', {}),
    call('connectors__linear__LINEAR_CREATE_ISSUE', { connector_alias: 'work', title: 'Bug' }, { result: { id: 1 } }),
    call('mcp__slack__send_message', { text: 'hi' }, { result: { error: 'nope' }, outcome: { duration: 1_200, kind: 'error' } }),
    call('tool_call', { calls: [] }, batch('connectors__linear__LINEAR_CREATE_ISSUE', 'mcp__slack__send_message')),
    call('tool_call', { calls: [] }, batch('connectors__linear__LINEAR_CREATE_ISSUE', 'read_file')),
    call('tool_call', { calls: [] }, batch('connectors__linear__LINEAR_CREATE_ISSUE', 'connectors__linear__LINEAR_GET_ISSUE'))
  ]
}
