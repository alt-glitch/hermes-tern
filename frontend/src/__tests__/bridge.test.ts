import { describe, expect, it } from 'vitest'

import { appOf, batchOf, callApp, unwrap } from '../bridge.js'
import { toolCallId } from '../core/ids.js'
import type { ToolCall } from '../model.js'
import { Transcript } from '../transcript.js'
import { stepLabel, summarize } from '../workLog.js'

const results = (...entries: Record<string, unknown>[]) => JSON.stringify({ results: entries.map((e, index) => ({ index, ...e })) })

describe('the tool_call bridge', () => {
  it('names connectors and MCP tools by app and action, as Hermes labels them', () => {
    expect(appOf('connectors__linear__LINEAR_CREATE_ISSUE')).toEqual({ action: 'create issue', app: 'Linear', kind: 'connector' })
    expect(appOf('connectors__googlecalendar__GOOGLECALENDAR_FIND_EVENT', { connector_alias: 'work' })?.action).toBe('find event (work)')
    expect(appOf('mcp__my-server__do_thing')).toEqual({ action: 'do thing', app: 'My Server', kind: 'mcp' })
    expect(appOf('connectors__granola_mcp__LIST_MEETINGS')?.app).toBe('Granola')
    expect(appOf('connectors__execute')).toBeUndefined()
    expect(appOf('terminal')).toBeUndefined()
  })

  it('unwraps one call, keeps a batch, and passes other calls through', () => {
    expect(unwrap('tool_call', { arguments: { action: 'list' }, name: 'cronjob_manage' })).toEqual({
      args: { action: 'list' },
      name: 'cronjob_manage',
      via: { kind: 'bridged' }
    })
    expect(unwrap('tool_call', { calls: [{ arguments: { a: 1 }, name: 'connectors__linear__X' }] }).name).toBe('connectors__linear__X')
    expect(unwrap('tool_call', { calls: [{ name: 'connectors__linear__X' }, { name: 'connectors__slack__Y' }] }).via).toMatchObject({ entries: [{ name: 'connectors__linear__X' }, { name: 'connectors__slack__Y' }], kind: 'batch' })
    expect(batchOf(unwrap('tool_call', { calls: [{ name: 'connectors__linear__X' }, { name: 'connectors__slack__Y' }] }))?.map(e => e.name)).toEqual([
      'connectors__linear__X',
      'connectors__slack__Y'
    ])
    expect(unwrap('terminal', { command: 'ls' })).toEqual({ args: { command: 'ls' }, name: 'terminal', via: { kind: 'direct' } })
  })

  it('settles a live connector call and a batch from the results list', () => {
    const t = new Transcript()
    t.messageStart()
    t.toolStart({ args: { arguments: { limit: 3 }, name: 'connectors__linear__LINEAR_LIST_ISSUES' }, name: 'tool_call', tool_id: 'one' })
    t.toolComplete({ name: 'tool_call', result: results({ response: { issues: [] } }), tool_id: 'one' })
    t.toolStart({ args: { calls: [{ name: 'connectors__linear__A' }, { name: 'connectors__slack__B' }] }, name: 'tool_call', tool_id: 'two' })
    t.toolComplete({ name: 'tool_call', result: results({ response: 'ok' }, { error: { code: 'X', message: 'no slack' } }), tool_id: 'two' })

    const [one, two] = t.calls('connectors__linear__LINEAR_LIST_ISSUES').concat(t.calls('tool_call'))

    expect([one?.name, one?.outcome.kind, one?.result]).toEqual(['connectors__linear__LINEAR_LIST_ISSUES', 'done', { issues: [] }])
    expect(two?.outcome.kind).toBe('done')
    expect(two && batchOf(two)?.map(e => e.outcome)).toEqual([
      { kind: 'done', result: 'ok' },
      { error: 'no slack', kind: 'error' }
    ])
    expect(callApp(one!)).toMatchObject({ action: 'list issues', app: 'Linear' })
  })

  it('unwraps stored bridge calls on resume', () => {
    const t = new Transcript()
    t.load([
      { role: 'user', text: 'go' },
      {
        args: { calls: [{ arguments: {}, name: 'connectors__slack__SLACK_SEND_MESSAGE' }] },
        content: results({ error: 'not connected' }),
        name: 'tool_call',
        role: 'tool',
        tool_call_id: 'c1'
      }
    ] as never)

    const [call] = t.calls('connectors__slack__SLACK_SEND_MESSAGE')

    expect([call?.outcome.kind, call?.via]).toEqual(['error', { kind: 'bridged' }])
  })

  it('summarizes connector work by app, and tool lookups apart', () => {
    const item = (name: string, args: Record<string, unknown> = {}) => {
      const u = unwrap(name, args)

      const id = toolCallId(name)

      const call: ToolCall = { args: u.args, argsText: '', context: '', id, name: u.name, outcome: { duration: 0, kind: 'done' }, startedAt: 0, via: u.via }

      return { call, id, kind: 'tool' as const }
    }
    const batch = item('tool_call', { calls: [{ name: 'connectors__linear__LINEAR_CREATE_ISSUE' }, { name: 'connectors__slack__SLACK_SEND_MESSAGE' }] })

    expect(summarize([item('tool_search', { queries: ['linear'] }), batch, item('connectors__linear__LINEAR_LIST_ISSUES')])).toBe(
      'Looked up tools and used Linear and Slack'
    )
    expect(summarize([item('connectors__linear__A'), item('connectors__linear__B')])).toBe('Used Linear 2 times')
    expect(stepLabel(batch.call)).toBe('Linear · create issue, Slack · send message')
    expect(stepLabel(item('tool_search', { queries: ['linear'] }).call)).toBe('Searched tools for linear')
  })
})
