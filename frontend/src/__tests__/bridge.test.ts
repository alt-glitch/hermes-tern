import { describe, expect, it } from 'vitest'

import { appOf, callApp, unwrap } from '../bridge.js'
import { Transcript } from '../transcript.js'
import { stepLabel, summarize } from '../workLog.js'

const results = (...entries: Record<string, unknown>[]) => JSON.stringify({ results: entries.map((e, index) => ({ index, ...e })) })

describe('the tool_call bridge', () => {
  it('names connectors and MCP tools by app and action, as Hermes labels them', () => {
    expect(appOf('connectors__linear__LINEAR_CREATE_ISSUE')).toEqual({ action: 'create issue', app: 'Linear', kind: 'connector' })
    expect(appOf('connectors__googlecalendar__GOOGLECALENDAR_FIND_EVENT', { connector_alias: 'work' })?.action).toBe('find event (work)')
    expect(appOf('mcp__my-server__do_thing')).toEqual({ action: 'do thing', app: 'My Server', kind: 'mcp' })
    expect(appOf('connectors__execute')).toBeUndefined()
    expect(appOf('terminal')).toBeUndefined()
  })

  it('unwraps one call, keeps a batch, and passes other calls through', () => {
    expect(unwrap('tool_call', { arguments: { action: 'list' }, name: 'cronjob_manage' })).toEqual({
      args: { action: 'list' },
      name: 'cronjob_manage',
      via: 'tool_call'
    })
    expect(unwrap('tool_call', { calls: [{ arguments: { a: 1 }, name: 'connectors__linear__X' }] }).name).toBe('connectors__linear__X')
    expect(unwrap('tool_call', { calls: [{ name: 'connectors__linear__X' }, { name: 'connectors__slack__Y' }] }).batch?.map(e => e.name)).toEqual([
      'connectors__linear__X',
      'connectors__slack__Y'
    ])
    expect(unwrap('terminal', { command: 'ls' })).toEqual({ args: { command: 'ls' }, name: 'terminal' })
  })

  it('settles a live connector call and a batch from the results list', () => {
    const t = new Transcript()
    t.start()
    t.toolStart({ args: { arguments: { limit: 3 }, name: 'connectors__linear__LINEAR_LIST_ISSUES' }, name: 'tool_call', tool_id: 'one' })
    t.toolComplete({ name: 'tool_call', result: results({ response: { issues: [] } }), tool_id: 'one' })
    t.toolStart({ args: { calls: [{ name: 'connectors__linear__A' }, { name: 'connectors__slack__B' }] }, name: 'tool_call', tool_id: 'two' })
    t.toolComplete({ name: 'tool_call', result: results({ response: 'ok' }, { error: { code: 'X', message: 'no slack' } }), tool_id: 'two' })

    const [one, two] = t.calls('connectors__linear__LINEAR_LIST_ISSUES').concat(t.calls('tool_call'))

    expect([one?.name, one?.status, one?.result]).toEqual(['connectors__linear__LINEAR_LIST_ISSUES', 'done', { issues: [] }])
    expect(two?.status).toBe('done')
    expect(two?.batch?.map(e => [e.status, e.error ?? e.result])).toEqual([
      ['done', 'ok'],
      ['error', 'no slack']
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

    expect([call?.status, call?.via]).toEqual(['error', 'tool_call'])
  })

  it('summarizes connector work by app, and tool lookups apart', () => {
    const item = (name: string, args: Record<string, unknown> = {}) => {
      const u = unwrap(name, args)

      return { call: { args: u.args, argsText: '', batch: u.batch, context: '', id: name, name: u.name, startedAt: 0, status: 'done' as const }, id: name, kind: 'tool' as const }
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
