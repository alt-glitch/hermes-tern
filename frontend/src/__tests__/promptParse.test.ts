import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import { describe, expect, it } from 'vitest'

import { parsePrompt } from '../prompts/parse.js'

function request(method: string, params: Record<string, unknown>): ServerRequest {
  return { fail: () => undefined, id: 'r1', method, params, respond: () => undefined }
}

const approval = (params: Record<string, unknown>) => parsePrompt(request('approval', params))

describe('parsePrompt: approval', () => {
  it('offers every answer by default', () => {
    expect(approval({ command: 'rm -rf build' })).toMatchObject({
      choices: ['once', 'session', 'always', 'deny'],
      command: 'rm -rf build',
      description: '',
      kind: 'approval',
      requestId: undefined,
      smartDenied: false
    })
  })

  it('takes explicit choices first, and keeps only known strings', () => {
    expect(approval({ choices: ['deny', 7, 'nope', 'once', 'deny'] })).toMatchObject({ choices: ['deny', 'once'] })
  })

  it('leaves once and deny after a smart-guard deny, and drops always with no permanent scope', () => {
    expect(approval({ smart_denied: true })).toMatchObject({ choices: ['once', 'deny'], smartDenied: true })
    expect(approval({ allow_permanent: false })).toMatchObject({ choices: ['once', 'session', 'deny'] })
    // Only `false` counts: a missing or null flag keeps the default.
    expect(approval({ allow_permanent: null, smart_denied: 'yes' })).toMatchObject({ choices: ['once', 'session', 'always', 'deny'], smartDenied: false })
  })

  it('drops the session scope when the request forbids it, even from explicit choices', () => {
    expect(approval({ allow_session: false, choices: ['once', 'session', 'deny'] })).toMatchObject({ choices: ['once', 'deny'] })
  })

  it('reads a mistyped field as empty, and keeps the queue id only when it is a string', () => {
    expect(approval({ command: 42, description: ['x'], request_id: 9 })).toMatchObject({ command: '', description: '', requestId: undefined })
    expect(approval({ request_id: 'q1' })).toMatchObject({ requestId: 'q1' })
  })
})

describe('parsePrompt: clarify and masked values', () => {
  it('drops questions with no qid or a blank question, and keeps the answers a replay locked', () => {
    expect(
      parsePrompt(
        request('clarify', {
          answers: { q1: 'yes', q2: null, q3: 4 },
          questions: [{ choices: ['a', 1], multi_select: true, qid: 'q1', question: ' Which? ' }, { qid: 'q2', question: '  ' }, { question: 'No id?' }, 'junk']
        })
      )
    ).toMatchObject({
      answers: { q1: 'yes', q2: null },
      kind: 'clarify',
      questions: [{ choices: ['a'], multi: true, qid: 'q1', question: 'Which?' }]
    })
  })

  it('reads every masked field whatever the method, falling back as the sheet titles do', () => {
    expect(parsePrompt(request('vault.save_login', { origin: 'https://x.dev' }))).toMatchObject({ kind: 'masked', method: 'vault.save_login', site: 'https://x.dev' })
    expect(parsePrompt(request('vault.unlock_prompt', { backend: 'bitwarden', display_name: '' }))).toMatchObject({ manager: 'bitwarden' })
    expect(parsePrompt(request('sudo', { command: 'apt install x' }))).toMatchObject({ command: 'apt install x', method: 'sudo' })
  })

  it('reads no prompt from a method this frontend does not answer', () => {
    expect(parsePrompt(request('tour', {}))).toBeUndefined()
    expect(parsePrompt(request('nonsense', {}))).toBeUndefined()
  })
})
