// Exact packaged prepare-architecture -> scoped /visual discovery -> native summary.
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { entryId, liveSessionId, storedSessionId, toolCallId } from '../core/ids.js'
import type { Entry, ToolCall } from '../model.js'
import type { Overlay } from '../overlays/overlay.js'
import { openVisual, type VisualHost } from '../overlays/visual.js'
import { parseVisualCandidate, recentVisualCandidates, type VisualCandidate } from '../visual-discovery.js'
import { readPreparedVisual } from '../visuals.js'
import { decodeJson } from '../wire/json.js'
import { openUiContract } from '../wire/openui.js'

import { must, stub } from './fakes.js'

const execute = promisify(execFile)
const openui = fileURLToPath(new URL('../../openui/', import.meta.url))
const scope = '["stored","main"]'
let scratch = ''
let notice: VisualCandidate
let output = ''

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'hermes-architecture-board-'))
  const env = { ...process.env }
  delete env['OPENUI_TELEMETRY_DISABLED']
  delete env['DO_NOT_TRACK']
  const result = await execute(process.execPath, [
    join(openui, 'prepare.mjs'),
    'prepare-architecture',
    join(openui, 'openui-generation/fixtures/architecture.openui'),
    join(openui, 'openui-preview/fixtures/architecture-board.json'),
    scope, join(scratch, 'bundles'), '--json'
  ], { env, timeout: 30_000, maxBuffer: 128 * 1024 })
  expect(result.stderr).toBe('')
  output = result.stdout
  const found = parseVisualCandidate(output, scope, 'architecture-tool')
  if (!found) throw new Error('Expected the exact machine-readable architecture candidate notice.')
  notice = found
})

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

function transcript(): Entry[] {
  const call: ToolCall = {
    id: toolCallId('architecture-tool'),
    name: 'terminal',
    args: {},
    argsText: '',
    context: '',
    startedAt: 0,
    outcome: { kind: 'done', duration: 1 },
    via: { kind: 'direct' },
    result: { exit_code: 0, output }
  }
  return [{
    kind: 'turn', id: entryId('architecture-turn'), rev: 0,
    end: { status: 'done' }, startedAt: 0,
    blocks: [{ kind: 'tool', id: call.id, call }]
  }]
}

describe('ephemeral-ui authored architecture board', () => {
  it('prepares only a host-owned synthetic architecture, with validated document identity', async () => {
    const contract = await openUiContract()
    const bundle = contract.validateBundle(decodeJson(await readFile(notice.path, 'utf8')))
    expect(bundle.selection.view.kind).toBe('architecture-board')
    if (bundle.selection.view.kind !== 'architecture-board') throw new Error('Expected architecture view.')
    expect(bundle.artifact.document.title).toContain('Synthetic architecture')
    expect((await readPreparedVisual(notice.path, scope)).edges).toHaveLength(3)
    expect(notice.id).toBe(bundle.id)
    contract.assertCurrent(bundle, scope, await contract.fingerprints())
  })

  it('summarizes node and intent-edge counts; no edge is called a verified integration', async () => {
    const summary = await readPreparedVisual(notice.path, scope)
    expect(summary.mode).toBe('architecture')
    expect(summary.metrics).toEqual([
      { key: 'nodes', label: 'Nodes', value: 3 },
      { key: 'edges', label: 'Intent edges', value: 3 }
    ])
    expect(summary.edges).toHaveLength(3)
    expect(summary.edges?.every(edge => edge.startsWith('Intent only: ') && edge.endsWith('not verified integration'))).toBe(true)
    await expect(readPreparedVisual(notice.path, '["stored","other"]')).rejects.toThrow('scope')
  })

  it('discovers the CLI candidate only from a successful terminal result and preserves the /visual identity', () => {
    const found = recentVisualCandidates(transcript(), scope)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ id: notice.id, path: notice.path, scope })
    expect(recentVisualCandidates(transcript(), '["other","main"]')).toEqual([])
  })

  it('opens the actual validated candidate in the native overlay with every edge disclosed', async () => {
    const overlays: Overlay[] = []
    const app = {
      overlays,
      session: { ref: { live: liveSessionId('runtime'), stored: storedSessionId('stored') }, info: { branch: 'main' } },
      transcript: { entries: transcript() },
      open: (overlay: Overlay) => { overlays.push(overlay) },
      close: (overlay: Overlay) => { const index = overlays.indexOf(overlay); if (index >= 0) overlays.splice(index, 1) },
      changed: vi.fn()
    }
    await openVisual(stub<VisualHost>(app), notice.path)
    const rendered = JSON.stringify(must(overlays[0]).node('architecture-preview'))
    expect(rendered).toContain('Authored architecture')
    expect(rendered).toContain('Intent only: browser')
    expect(rendered).toContain('not verified integration')
    expect(rendered).toContain(notice.id)
    expect(rendered).toContain('file://')
  })
})
