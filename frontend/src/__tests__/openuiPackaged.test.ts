// Real packaged CLI → donor validator → Tern preview; no fake parser or LoadVisual.
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Node } from '@stencil-hq/tern'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as z from 'zod/mini'

import { liveSessionId, storedSessionId } from '../core/ids.js'
import type { Entry } from '../model.js'
import type { Overlay } from '../overlays/overlay.js'
import { openVisual, type VisualHost } from '../overlays/visual.js'
import { readPreparedVisual, readVisualFile } from '../visuals.js'
import { decodeJson, record } from '../wire/json.js'
import { openUiContract } from '../wire/openui.js'

import { must, stub } from './fakes.js'

const execute = promisify(execFile)
const openui = fileURLToPath(new URL('../../openui/', import.meta.url))
const scope = '["stored","main"]'
const candidateNotice = z.object({
  kind: z.literal('hermes.visual.candidate'),
  version: z.literal(1),
  id: z.string(),
  path: z.string(),
  scope: z.literal(scope)
})
const hash = /^[a-f0-9]{64}$/
const hashedAssets = [
  'openui-preview/src/bundle.mjs',
  'openui-preview/src/intent-document.mjs',
  'openui-preview/src/architecture-document.mjs',
  'openui-preview/src/control.mjs',
  'openui-preview/src/lifecycle.mjs',
  'openui-preview/tern/plugin.toml',
  'openui-preview/tern/host.luau',
  'openui-preview/tern/window.luau',
  'openui-preview/tern/visual.css',
  'openui-generation/src/adapter.mjs',
  'openui-generation/src/catalog.mjs',
  'openui-generation/src/host.mjs',
  'openui-generation/src/intent.mjs',
  'openui-generation/src/architecture.mjs',
  'openui-generation/fixtures/architecture.v0.json',
  'openui-generation/fixtures/architecture-services.v0.json',
  'openui-generation/src/static-program.mjs',
  'openui-generation/package-lock.json'
] as const

let scratch = ''
let candidate: z.infer<typeof candidateNotice>
let bundle: unknown

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'hermes-packaged-openui-'))
  const env = { ...process.env }
  delete env['HERMES_PYTHON_SRC_ROOT']
  delete env['OPENUI_TELEMETRY_DISABLED']
  delete env['DO_NOT_TRACK']

  // The shipped wrapper disables both telemetry flags before the unmodified
  // donor CLI imports real @openuidev/lang-core from the frozen Bun workspace.
  // A missing parser fails instead of skipping this suite.
  const { stdout, stderr } = await execute(process.execPath, [
    join(openui, 'prepare.mjs'),
    'prepare',
    join(openui, 'openui-generation/fixtures/explorer.openui'),
    join(openui, 'openui-preview/fixtures/repository.json'),
    scope,
    join(scratch, 'bundles'),
    '--json'
  ], { env, timeout: 30_000, maxBuffer: 128 * 1024 })
  expect(stderr).toBe('')
  const notice = candidateNotice.safeParse(decodeJson(stdout))
  if (!notice.success) {
    throw new Error('Real prepare CLI did not return one complete candidate notice.')
  }
  candidate = notice.data
  bundle = decodeJson(await readFile(candidate.path, 'utf8'))
})

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

async function mirrorAssets(): Promise<void> {
  const src = join(scratch, 'source-copy')
  await mkdir(src, { recursive: true })
  for (const relative of hashedAssets) {
    const dest = join(src, relative)
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(join(openui, relative), dest)
  }
}

async function mirroredBuild(): Promise<unknown> {
  const url = pathToFileURL(join(scratch, 'source-copy/openui-preview/src/bundle.mjs')).href
  // Execute the same original module under Node, outside Vitest's transform
  // cache, so mutated on-disk assets are what fingerprints() actually hashes.
  const { stdout, stderr } = await execute(process.execPath, [
    '--input-type=module', '--eval',
    'const mod = await import(process.argv[1]); process.stdout.write(JSON.stringify(await mod.fingerprints()))',
    url
  ], { timeout: 10_000, maxBuffer: 16 * 1024 })
  expect(stderr).toBe('')
  return decodeJson(stdout)
}

function nativeHost() {
  const overlays: Overlay[] = []
  const session = {
    ref: { live: liveSessionId('runtime'), stored: storedSessionId('stored') },
    info: { branch: 'main' }
  }
  const entries: Entry[] = []
  const transcript = { entries }
  const changed = vi.fn()
  const close = (overlay: Overlay) => {
    const at = overlays.indexOf(overlay)
    if (at >= 0) {
      overlays.splice(at, 1)
      overlay.onClose?.()
    }
  }
  const open = (overlay: Overlay) => overlays.push(overlay)
  return { overlays, session, transcript, changed, close, open }
}

describe('packaged OpenUI preview with real donor assets and Tern SDK', () => {
  it('prepares real JSON and previews its strict validated identity and summary without a fork checkout', async () => {
    vi.stubEnv('HERMES_PYTHON_SRC_ROOT', '')
    const contract = await openUiContract()
    const current = await contract.fingerprints()
    expect(record(current)?.['rendererHash']).toMatch(hash)
    expect(record(current)?.['bridgeHash']).toMatch(hash)
    expect(candidate.id).toMatch(hash)
    expect(candidate.path).toMatch(/\.hvisual\.json$/)
    const validated = contract.validateBundle(bundle)
    expect(validated.id).toBe(candidate.id)
    contract.assertCurrent(validated, scope, current)

    const summary = await readPreparedVisual(candidate.path, scope)
    expect(summary).toMatchObject({
      id: candidate.id, mode: 'code', path: candidate.path,
      metrics: [
        { key: 'files', value: 4 },
        { key: 'code', value: 1000 },
        { key: 'churn', value: 100 }
      ]
    })
    expect(summary.href).toBe(pathToFileURL(candidate.path).href)
  })

  it('prepares an ephemeral-intent/v1 board with the real parser and summarizes the sections the model chose', async () => {
    const env = { ...process.env }
    delete env['OPENUI_TELEMETRY_DISABLED']
    delete env['DO_NOT_TRACK']
    const { stdout, stderr } = await execute(process.execPath, [
      join(openui, 'prepare.mjs'),
      'prepare-intent',
      join(openui, 'openui-generation/fixtures/intent.openui'),
      join(openui, 'openui-preview/fixtures/intent-board.json'),
      scope,
      join(scratch, 'intent'),
      '--json'
    ], { env, timeout: 30_000, maxBuffer: 128 * 1024 })
    expect(stderr).toBe('')
    const notice = candidateNotice.parse(decodeJson(stdout))
    const summary = await readPreparedVisual(notice.path, scope)

    expect(summary).toMatchObject({ id: notice.id, mode: 'intent', metrics: [{ key: 'sections', value: 8 }, { key: 'slices', value: 3 }] })
    expect(summary.sections).toEqual([
      'DeclaredIntent', 'ContractGates', 'WorkSlices', 'ProofReceipts', 'DecisionMix(execution)', 'TokenValue', 'ContextFlow', 'RuntimeHealth'
    ])
    await expect(readPreparedVisual(notice.path, JSON.stringify(['other', 'main']))).rejects.toThrow()
  })

  it('mounts the real validated summary using native @stencil-hq/tern JSX and expires on branch switch', async () => {
    const state = nativeHost()
    await openVisual(stub<VisualHost>(state), candidate.path)
    const sheet = must(state.overlays[0])
    const node = sheet.node('openui-preview')
    expect(node).toBeInstanceOf(Node)
    const rendered = JSON.stringify(node)
    expect(rendered).toContain(candidate.id)
    expect(rendered).toContain('Synthetic repository')
    expect(rendered).toContain('not visually verified or published')
    expect(rendered).toContain('file://')

    state.session.info.branch = 'other'
    expect(JSON.stringify(sheet.node('openui-preview'))).toContain('Session, branch or transcript changed')
  })

  it('rejects changed scope, unexpected candidate identity and tampered JSON', async () => {
    await expect(readPreparedVisual(candidate.path, '["stored","other"]')).rejects.toThrow('scope')
    const state = nativeHost()
    await openVisual(stub<VisualHost>(state), candidate.path, readPreparedVisual, 'f'.repeat(64))
    expect(JSON.stringify(must(state.overlays[0]).node('openui-preview'))).toContain('no longer matches')

    const changed = record(structuredClone(bundle))
    if (!changed) throw new Error('Expected a JSON preview object.')
    changed['bridgeHash'] = 'e'.repeat(64)
    const bad = join(scratch, 'tampered.hvisual.json')
    await writeFile(bad, JSON.stringify(changed))
    await expect(readPreparedVisual(bad, scope)).rejects.toThrow()
  })

  it('rejects modified real renderer and parser fingerprints, not just version labels', async () => {
    const contract = await openUiContract()
    const validated = contract.validateBundle(bundle)
    await mirrorAssets()
    const initial = record(await mirroredBuild())
    const shipped = record(await contract.fingerprints())
    expect(initial).toEqual(shipped)

    const css = join(scratch, 'source-copy/openui-preview/tern/visual.css')
    await writeFile(css, (await readFile(css, 'utf8')) + '\n/* source drift */\n')
    const rendererDrift = record(await mirroredBuild())
    expect(rendererDrift?.['rendererHash']).not.toBe(shipped?.['rendererHash'])
    expect(rendererDrift?.['bridgeHash']).toBe(shipped?.['bridgeHash'])
    expect(() => contract.assertCurrent(validated, scope, rendererDrift)).toThrow('Renderer or adapter')

    const parser = join(scratch, 'source-copy/openui-generation/src/static-program.mjs')
    await writeFile(parser, (await readFile(parser, 'utf8')) + '\n// parser drift\n')
    const parserDrift = record(await mirroredBuild())
    expect(parserDrift?.['bridgeHash']).not.toBe(shipped?.['bridgeHash'])
    expect(() => contract.assertCurrent(validated, scope, parserDrift)).toThrow('Renderer or adapter')
  })

  it('fails closed on malformed UTF-8, byte limit and cancellation before or during read', async () => {
    const bad = join(scratch, 'invalid.hvisual.json')
    await writeFile(bad, Buffer.from([0xff]))
    await expect(readPreparedVisual(bad, scope)).rejects.toThrow()

    const size = join(scratch, 'oversized.hvisual.json')
    await writeFile(size, Buffer.alloc(8 * 1024 * 1024 + 1))
    await expect(readPreparedVisual(size, scope)).rejects.toThrow('bounded regular file')
    await expect(readVisualFile(size, 8 * 1024 * 1024)).rejects.toThrow()

    const stopped = new AbortController()
    stopped.abort()
    await expect(readPreparedVisual(candidate.path, scope, stopped.signal)).rejects.toThrow()
  })
})
