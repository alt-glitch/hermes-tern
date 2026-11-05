import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { Node } from '@stencil-hq/tern'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { entryId, liveSessionId, storedSessionId, toolCallId } from '../core/ids.js'
import type { Entry, ToolCall } from '../model.js'
import type { Overlay } from '../overlays/overlay.js'
import { openVisualPicker, type VisualPickerHost } from '../overlays/visualPicker.js'
import { readPreparedVisual } from '../visuals.js'
import { openCardContract } from '../wire/card.js'
import { decodeJson, record } from '../wire/json.js'

import { key, must, stub } from './fakes.js'

const execute = promisify(execFile)
const openui = fileURLToPath(new URL('../../openui/', import.meta.url))
const scope = '["synthetic-session","main"]'
const fixture = {
  kind: 'thread',
  app: 'gmail',
  title: 'Synthetic thread',
  subject: 'Invoice 42',
  summary: 'Synthetic due date',
  fields: { Sender: 'Sample person' },
  actions: 'host-confirmed',
  buttons: [{ label: 'Approve once', action: 'mail.send' }, 'Dismiss']
}
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), 'ephemeral-card-'))
  dirs.push(directory)
  return directory
}

async function prepare(card: unknown = fixture) {
  const dir = await scratch()
  const input = join(dir, 'card.json')
  await writeFile(input, JSON.stringify(card))
  const { stdout, stderr } = await execute(process.execPath, [
    join(openui, 'prepare.mjs'), 'prepare-card', input, scope, join(dir, 'out'), '--json'
  ], { timeout: 10_000, maxBuffer: 128 * 1024 })
  expect(stderr).toBe('')
  const notice = record(decodeJson(stdout))
  if (!notice || typeof notice['id'] !== 'string' || typeof notice['path'] !== 'string') {
    throw new Error('prepare-card did not emit its complete candidate notice.')
  }
  return { notice, path: notice['path'] }
}

function host() {
  const overlays: Overlay[] = []
  const transcript: { entries: Entry[] } = { entries: [] }
  const session = {
    ref: { live: liveSessionId('runtime'), stored: storedSessionId('synthetic-session') },
    info: { branch: 'main' }
  }
  const changed = vi.fn()
  const close = (o: Overlay) => {
    const i = overlays.indexOf(o)
    if (i >= 0) {
      overlays.splice(i, 1)
      o.onClose?.()
    }
  }
  const open = (o: Overlay) => {
    const previous = overlays.find(x => x.key === o.key)
    if (previous) close(previous)
    overlays.push(o)
  }
  return { overlays, transcript, session, changed, close, open }
}

function candidateEntry(id: string, path: string): Entry {
  const call: ToolCall = {
    id: toolCallId('card-terminal'), name: 'terminal', args: {}, argsText: '',
    context: '', startedAt: 0, outcome: { kind: 'done', duration: 1 },
    via: { kind: 'direct' },
    result: {
      exit_code: 0,
      output: JSON.stringify({ kind: 'hermes.visual.candidate', version: 1, id, path, scope })
    }
  }
  return {
    kind: 'turn', id: entryId('synthetic-turn'), rev: 0, end: { status: 'done' }, startedAt: 0,
    blocks: [{ kind: 'tool', id: call.id, call }]
  }
}

describe('pinned ephemeral-ui card.v0 contract', () => {
  it('ships the unchanged public gh-pages schema at the exact Git blob SHA', async () => {
    const bytes = await readFile(join(openui, 'schema/card.v0.json'))
    const sha = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex')
    expect(sha).toBe('ccafc9d00f95f21c389f8ce8a9aa14491475033f')
    const schema = record(decodeJson(bytes.toString('utf8')))
    expect(schema?.['required']).toEqual(['kind', 'app'])
    const kind = record(record(schema?.['properties'])?.['kind'])
    expect(kind?.['enum']).toContain('thread')
    expect(kind?.['enum']).toContain('trace-tools')
    expect(kind?.['enum']).toContain('infra-cluster')
  })

  it('accepts typed metadata and read-only text, including inert action labels', async () => {
    const validator = await openCardContract()
    expect(validator.validateCardDocument(fixture)).toBe(fixture)
    expect(validator.validateCardDocument({
      kind: 'trace-tools', app: 'omp-stats', actions: 'read-only',
      input: '/api/stats/tools?range=7d', layers: ['spans', 'cost'],
      options: { range: '7d', sort: 'p95' }, ttl: 0
    })).toMatchObject({ kind: 'trace-tools', ttl: 0 })
  })

  it('rejects unknown keys, missing requirements, bad enums, control text, and unsafe data', async () => {
    const validator = await openCardContract()
    const invalid: unknown[] = [
      {}, { kind: 'inbox' }, { kind: 'invented', app: 'gmail' },
      { kind: 'inbox', app: 'gmail', onClick: 'danger' },
      { kind: 'inbox', app: 'gmail', title: 'bad\nline' },
      { kind: 'inbox', app: 'gmail', body: 'bad\u202eorder' },
      { kind: 'inbox', app: 'gmail', appName: 'Gmail' },
      { kind: 'inbox', app: 'x'.repeat(81) },
      { kind: 'inbox', app: 'gmail', ttl: -1 },
      { kind: 'inbox', app: 'gmail', ttl: 1.5 },
      { kind: 'inbox', app: 'gmail', actions: 'send' },
      { kind: 'trace', app: 'omp-stats', actions: 'host-confirmed' },
      { kind: 'inbox', app: 'gmail', render: { brand: 'unsafe' } },
      { kind: 'inbox', app: 'gmail', layers: ['spans', 'spans'] },
      { kind: 'inbox', app: 'gmail', options: { sort: 'unknown' } },
      { kind: 'inbox', app: 'gmail', input: 'https://example.invalid/command' },
      { kind: 'inbox', app: 'gmail', buttons: [{ label: 'Go', href: 'https://example.invalid' }] },
      { kind: 'inbox', app: 'gmail', buttons: ['x'.repeat(81)] },
      { kind: 'inbox', app: 'gmail', fields: { 'Bad\nlabel': 'value' } },
      { kind: 'inbox', app: 'gmail', input: { items: Array(20).fill('x'.repeat(4096)) } }
    ]
    for (const item of invalid) expect(() => validator.validateCardDocument(item)).toThrow('Invalid card.v0')
  })

  it('prepares a content-addressed file without an OpenUI parser or a renderer', async () => {
    const { notice, path } = await prepare()
    expect(notice).toEqual({
      kind: 'hermes.visual.candidate', version: 1,
      id: expect.stringMatching(/^[a-f0-9]{64}$/), path, scope
    })
    expect(path).toMatch(/\.hvisual\.json$/)
    const prepared = await readPreparedVisual(path, scope)
    expect(prepared).toMatchObject({
      id: notice['id'], title: 'Synthetic thread', mode: 'card',
      card: { kind: 'thread', app: 'gmail', actions: 'host-confirmed',
        texts: [
          { label: 'Summary', value: 'Synthetic due date' },
          { label: 'Subject', value: 'Invoice 42' },
          { label: 'Sender', value: 'Sample person' }
        ],
        buttons: ['Approve once', 'Dismiss']
      }
    })
    expect(prepared.card?.texts).toHaveLength(3)
    expect(prepared.card?.buttons).toHaveLength(2)
    await expect(readPreparedVisual(path, '["different","main"]')).rejects.toThrow('scope')

    const tampered = join(await scratch(), 'changed.hvisual.json')
    const object = record(decodeJson(await readFile(path, 'utf8')))
    if (!object) throw new Error('Expected a prepared card envelope.')
    object['id'] = 'f'.repeat(64)
    await writeFile(tampered, JSON.stringify(object))
    await expect(readPreparedVisual(tampered, scope)).rejects.toThrow('identity')
  })

  it('lists completed terminal candidates and opens a native inert summary, not buttons or links', async () => {
    const { notice, path } = await prepare()
    const app = host()
    app.transcript.entries.push(candidateEntry(String(notice['id']), path))
    await openVisualPicker(stub<VisualPickerHost>(app), '')
    const picker = must(app.overlays.at(-1))
    expect(JSON.stringify(picker.node('picker'))).toContain('Recent visual candidates')
    expect(JSON.stringify(picker.node('picker'))).toContain(String(notice['id']).slice(0, 12))
    picker.onKey(key('enter'))
    await vi.waitFor(() => {
      const sheet = must(app.overlays.at(-1))
      expect(sheet.key).toBe('visual-preview')
      const native = sheet.node('native-card')
      expect(native).toBeInstanceOf(Node)
      const rendered = JSON.stringify(native)
      expect(rendered).toContain('Synthetic thread')
      expect(rendered).toContain('Invoice 42')
      expect(rendered).toContain('Sample person')
      expect(rendered).toContain('Approve once')
      expect(rendered).toContain('Buttons (labels only, disabled)')
      expect(rendered).toContain('No button, action, script or approval runs')
      expect(rendered).not.toContain('mail.send')
      expect(rendered).not.toContain('file://')
    })
    const active = must(app.overlays.at(-1))
    active.onKey(key('escape'))
    expect(app.overlays).toHaveLength(0)
  })

  it('fails a malformed CLI document without a candidate notice', async () => {
    const dir = await scratch()
    const input = join(dir, 'invalid.json')
    await writeFile(input, JSON.stringify({ kind: 'inbox', app: 'gmail', script: 'alert(1)' }))
    await expect(execute(process.execPath, [
      join(openui, 'prepare.mjs'), 'prepare-card', input, scope, join(dir, 'output'), '--json'
    ], { timeout: 10_000 })).rejects.toThrow()
  })
})
