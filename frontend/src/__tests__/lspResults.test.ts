// Typed Hermes LSP payloads through the plugin's tool-card registry, including
// stored JSON replay, malformed fallback, and Tern SDK semantic node metadata.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { NodeJson } from '@stencil-hq/tern'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { App } from '../app/chat.js'
import { detailOf, toolKeyOf } from '../tools/detail.js'
import { parseLspResult } from '../tools/lsp-result.js'
import { lspFileHref } from '../view/tools/lsp-links.js'
import { hubIconOf } from '../view/tools/registry.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { actionOf, stepLabel } from '../view/workLogModel.js'

import { FakeGateway, fakeTern, given, settle, topNodes, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const base = { path: '/project/src/a.py', server: 'pyright', position_encoding: 'utf-16' }
const span = { start: { line: 2, col: 3 }, end: { line: 4, col: 5 } }
const location = (path: string) => ({ path, range: span })
const symbol = (id: string, name: string, children: unknown[] = []) => ({
  id,
  name,
  kind: 5,
  location: location(base.path),
  selection: span,
  children
})
const envelope = (result: Record<string, unknown>) => ({ lsp_result: { ...base, ...result } })
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const role = (root: NodeJson, name: string): NodeJson[] => nodes(root).filter(n => n.p?.['role'] === name)
const lsp = (result: unknown, resultText?: string) => call('lsp', { operation: 'references', path: 'src/a.py' }, {
  result,
  ...(resultText === undefined ? {} : { resultText })
})

describe('LSP semantic result parsing', () => {
  it('retains cross-file locations, one-based UTF-16 ranges and checked-empty arrays', () => {
    const original = envelope({ kind: 'references', locations: [location(base.path), location('/project/src/b.py'), location(base.path)] })
    const parsed = parseLspResult(original.lsp_result)
    expect(parsed).toEqual(original.lsp_result)
    expect(parseLspResult(envelope({ kind: 'references', locations: [] }).lsp_result)).toMatchObject({ kind: 'references', locations: [] })
  })

  it('retains stable nested IDs, both ranges, and typed hover contents', () => {
    const nested = symbol('parent', 'Parent', [symbol('child', 'child')])
    expect(parseLspResult(envelope({ kind: 'symbols', symbols: [nested] }).lsp_result)).toMatchObject({ symbols: [nested] })
    expect(parseLspResult(envelope({ kind: 'hover', range: span, contents: [
      { format: 'markdown', text: '**bold**', language: null },
      { format: 'plaintext', text: '<literal>', language: null },
      { format: 'code', text: 'x = 1', language: 'python' }
    ] }).lsp_result)).toMatchObject({ kind: 'hover', range: span })
  })

  it('rejects legacy, foreign and malformed data instead of inventing results', () => {
    const malformed = [
      { text: '12 references' },
      { ...base, kind: 'references', locations: [{ path: '/project/a.py', range: { start: { line: 0, col: 1 }, end: span.end } }] },
      { ...base, kind: 'references', locations: [{ path: '/project/a.py', range: { start: span.end, end: span.start } }] },
      { ...base, kind: 'references', locations: [location(base.path), null] },
      { ...base, position_encoding: 'utf-8', kind: 'references', locations: [] },
      { ...base, server: undefined, kind: 'references', locations: [] },
      { ...base, kind: 'symbols', symbols: [symbol('same', 'A'), symbol('same', 'B')] },
      { ...base, kind: 'symbols', symbols: [symbol('outer', 'A', [symbol('outer', 'recursive ID')])] },
      { ...base, kind: 'symbols', symbols: [{ ...symbol('bad', 'A'), children: 'not-an-array' }] },
      { ...base, kind: 'symbols', symbols: [{ ...symbol('bad', 'A'), kind: 27 }] },
      { ...base, kind: 'hover', contents: [{ format: 'html', text: '<b>raw</b>' }], range: null },
      { ...base, kind: 'hover', contents: [], range: undefined },
      { ...base, kind: 'error', operation: 'rename', message: 'invalid' },
      { ...base, kind: 'unavailable', operation: 'symbols', message: null }
    ]

    for (const item of malformed) {
      expect(parseLspResult(item)).toBeUndefined()
    }
  })

  it('guards overly deep symbol trees', () => {
    let child = symbol('leaf', 'Leaf')

    for (let i = 0; i < 130; i++) {
      child = symbol('n' + i, 'Nested', [child])
    }

    expect(parseLspResult(envelope({ kind: 'symbols', symbols: [child] }).lsp_result)).toBeUndefined()
  })
})

describe('LSP tool cards', () => {
  it('registers one typed detail and work-log presentation, not a model tool', () => {
    const c = lsp(envelope({ kind: 'references', locations: [] }))
    expect(toolKeyOf('lsp')).toBe('lsp')
    expect(hubIconOf('lsp')).toBe('search')
    expect(stepLabel(c)).toBe('LSP references /project/src/a.py')
    expect(actionOf(c)).toBe('code-search')
    const first = detailOf(c)
    expect(detailOf(c)).toBe(first)
    expect(first).toMatchObject({ tool: 'lsp', result: { kind: 'references', locations: [] } })
    c.result = JSON.stringify(envelope({ kind: 'references', locations: [location(base.path)] }))
    expect(detailOf(c)).toMatchObject({ result: { locations: [location(base.path)] } })
  })

  it('groups references by source file without losing duplicates or complete spans', () => {
    const c = lsp(envelope({ kind: 'references', locations: [location(base.path), location('/project/src/b.py'), location(base.path)] }))
    const root = tree(toolNode(c, 4))
    expect(root).toMatchObject({ k: 'tool', p: { name: 'lsp', title: 'LSP', status: 'done', collapsed: false } })
    expect(role(root, 'omp.tool.references.file')).toHaveLength(2)
    expect(role(root, 'omp.tool.reference').map(n => n.p?.['text'])).toEqual(['2:3–4:5', '2:3–4:5', '2:3–4:5'])
    // With no proven frame locality, even a valid absolute target must remain inert.
    expect(nodes(root).every(n => n.p?.['href'] === undefined)).toBe(true)
    expect(role(root, 'omp.tool.notice')[0]?.p?.['spans']).toEqual([{ s: 'muted', t: 'File targets are not confirmed host-local; links disabled.' }])
  })

  it('preserves nested tree IDs and full source + selection range through stored JSON replay', () => {
    const payload = envelope({ kind: 'symbols', symbols: [symbol('parent', 'Outer', [symbol('child', 'method')])] })
    const live = tree(toolNode(lsp(payload), 1))
    const stored = tree(toolNode(lsp(JSON.stringify(payload)), 2))
    const a = role(live, 'omp.tool.symbols')[0]
    const b = role(stored, 'omp.tool.symbols')[0]
    expect(b?.p?.['nodes']).toEqual(a?.p?.['nodes'])
    expect(a?.p?.['nodes']).toMatchObject([{
      id: 'parent', open: true, children: [{ id: 'child', label: [{ t: 'method' }, {}] }]
    }])
    expect(role(stored, 'omp.tool.symbol.location')).toHaveLength(2)
    expect(role(stored, 'omp.tool.symbol.location')[1]?.p?.['text']).toContain('selection 2:3–4:5')
  })

  it('honors hover Markdown, literal plaintext and language-marked code', () => {
    const root = tree(toolNode(lsp(envelope({ kind: 'hover', range: span, contents: [
      { format: 'markdown', text: '**marked**', language: null },
      { format: 'plaintext', text: '<literal>', language: null },
      { format: 'code', text: 'def f(): pass', language: 'python' }
    ] })), 5))
    expect(role(root, 'omp.tool.hover').map(n => n.k)).toEqual(['md', 'text', 'code'])
    expect(role(root, 'omp.tool.hover').map(n => n.p?.['text'])).toEqual(['**marked**', '<literal>', 'def f(): pass'])
    expect(role(root, 'omp.tool.hover')[2]?.p?.['lang']).toBe('python')
    expect(role(root, 'omp.tool.hover.range')[0]?.p?.['text']).toBe('2:3–4:5')
  })

  it.each(['references', 'symbols', 'hover'] as const)('distinguishes empty %s from error and unavailable', kind => {
    const empty = kind === 'references' ? { locations: [] } : kind === 'symbols' ? { symbols: [] } : { contents: [], range: null }
    const checked = tree(toolNode(lsp(envelope({ ...empty, kind })), 0))
    expect(role(checked, 'omp.tool.lsp.summary')[0]?.p?.['text']).toContain('(checked)')

    for (const failure of ['error', 'unavailable'] as const) {
      const root = tree(toolNode(lsp(envelope({ kind: failure, operation: kind, message: 'server not ready' })), 0))
      expect(root.p?.['status']).toBe(failure === 'error' ? 'error' : 'done')
      expect(role(root, 'omp.tool.lsp.' + failure)[0]?.p?.['text']).toBe(kind + ': server not ready')
      expect(role(root, 'omp.tool.lsp.summary')).toHaveLength(0)
    }
  })

  it('retains 250 references and very long paths instead of clipping at pane width', () => {
    const long = 'dir-with-a-long-name-'.repeat(25)
    const root = tree(toolNode(lsp(envelope({ path: '/project/' + long + '.py', kind: 'references', locations: Array.from({ length: 250 }, () => location('/project/' + long + '.py')) })), 1))
    expect(role(root, 'omp.tool.reference')).toHaveLength(250)
    expect(role(root, 'omp.tool.file').some(n => n.p?.['text'] === '/project/' + long + '.py' && n.p?.['wrap'] === 'word')).toBe(true)
  })

  it('keeps foreign or malformed semantic objects in the literal generic fallback', () => {
    for (const result of [
      { text: '12 references' },
      envelope({ kind: 'references', locations: [{ path: 'bad', range: { start: { line: -1, col: 2 }, end: span.end } }] })
    ]) {
      const root = tree(toolNode(lsp(result), 0))
      expect(role(root, 'omp.tool.reference')).toHaveLength(0)
      expect(nodes(root).find(n => n.k === 'code')?.p?.['text']).toContain(JSON.stringify(result).slice(0, 1))
    }

    const raw = '{"raw":"stored legacy result"}'
    expect(nodes(tree(toolNode(lsp({ message: 'ignored' }, raw), 0))).find(n => n.k === 'code')?.p?.['text']).toBe(raw)
  })

  it('does not strip a valid tool result from a work-group detail', () => {
    const c = lsp(envelope({ kind: 'references', locations: [location(base.path)] }))
    const body = toolDetail(c, 10).map(tree)
    expect(body.flatMap(nodes).filter(n => n.p?.['role'] === 'omp.tool.reference')).toHaveLength(1)
  })

  it('escapes terminal controls in displayed paths and messages', () => {
    const path = '/project/' + String.fromCharCode(27) + '[31mred.py'
    const root = tree(toolNode(lsp(envelope({ path, kind: 'unavailable', operation: 'hover', message: 'bad' + String.fromCharCode(0) + 'file' })), 0))
    expect(role(root, 'omp.tool.file')[0]?.p?.['text']).toBe('/project/red.py')
    expect(role(root, 'omp.tool.lsp.unavailable')[0]?.p?.['text']).toBe('hover: bad\\u0000file')
  })
})

const local = { cwd: '/project', hostLocal: true }
const referencePayload = envelope({
  kind: 'references',
  locations: [location('src/a.py'), location('/project/src/b.py'), location('src/a.py')]
})

describe('LSP file hrefs through the typed tool registry', () => {
  it('links result paths, grouped files and every full reference range when host-local', () => {
    const root = tree(toolNode(lsp(referencePayload), 1, local))
    expect(role(root, 'omp.tool.file').map(n => n.p?.['href'])).toEqual([
      'file:///project/src/a.py', 'file:///project/src/a.py', 'file:///project/src/b.py'
    ])
    expect(role(root, 'omp.tool.reference').map(n => n.p?.['href'])).toEqual([
      'file:///project/src/a.py#L2-L4',
      'file:///project/src/a.py#L2-L4',
      'file:///project/src/b.py#L2-L4'
    ])
    expect(role(root, 'omp.tool.reference').map(n => n.p?.['text'])).toEqual([
      '2:3–4:5', '2:3–4:5', '2:3–4:5'
    ])
    expect(role(root, 'omp.tool.notice')).toHaveLength(0)
    expect(toolDetail(lsp(referencePayload), 1, local).map(tree).flatMap(nodes)
      .filter(n => n.p?.['role'] === 'omp.tool.reference' && typeof n.p?.['href'] === 'string')).toHaveLength(3)
  })

  it('links nested symbol-label spans and source rows through live and JSON-replayed results', () => {
    const payload = envelope({ kind: 'symbols', symbols: [symbol('outer', 'Outer', [symbol('inner', 'method')])] })
    for (const result of [payload, JSON.stringify(payload)]) {
      const root = tree(toolNode(lsp(result), 2, local))
      expect(role(root, 'omp.tool.symbols')[0]?.p?.['nodes']).toMatchObject([{
        id: 'outer',
        open: true,
        label: [{ t: 'Outer', href: 'file:///project/src/a.py#L2-L4' }, {}],
        children: [{
          id: 'inner',
          label: [{ t: 'method', href: 'file:///project/src/a.py#L2-L4' }, {}]
        }]
      }])
      expect(role(root, 'omp.tool.symbol.location').map(n => n.p?.['href'])).toEqual([
        'file:///project/src/a.py#L2-L4', 'file:///project/src/a.py#L2-L4'
      ])
      expect(role(root, 'omp.tool.symbol.location')[0]?.p?.['text']).toContain('selection 2:3–4:5')
    }
  })

  it('links hover ranges without changing Markdown, literal text or syntax-marked code', () => {
    const payload = envelope({ kind: 'hover', range: span, contents: [
      { format: 'markdown', text: '**hi**', language: null },
      { format: 'code', text: 'x = 1', language: 'python' },
      { format: 'plaintext', text: '<literal>', language: null }
    ] })
    const root = tree(toolNode(lsp(JSON.stringify(payload)), 2, local))
    expect(role(root, 'omp.tool.hover.range')[0]?.p?.['href']).toBe('file:///project/src/a.py#L2-L4')
    expect(role(root, 'omp.tool.hover').map(n => n.k)).toEqual(['md', 'code', 'text'])
    expect(role(root, 'omp.tool.hover')[1]?.p?.['lang']).toBe('python')
  })

  it('blocks schemes, control bytes, ambiguous cwd and unsafe targets rather than retargeting them', () => {
    expect(lspFileHref('/project/a b#c%.py', local, span)).toBe('file:///project/a%20b%23c%25.py#L2-L4')
    for (const target of [
      'file:///etc/passwd', 'https://host/x', '//server/share',
      '/project/a' + String.fromCharCode(0) + 'b.py',
      '/project/' + String.fromCharCode(0x202e) + 'hidden.py', ''
    ]) {
      expect(lspFileHref(target, local)).toBeUndefined()
    }
    expect(lspFileHref('src/a.py', { cwd: 'relative', hostLocal: true })).toBeUndefined()
    expect(lspFileHref('src/a.py', { cwd: '/project', hostLocal: false })).toBeUndefined()
    const malicious = tree(toolNode(lsp(envelope({
      kind: 'references', locations: [location('https://remote/file.py')]
    })), 2, local))
    expect(role(malicious, 'omp.tool.reference')[0]?.p?.['href']).toBeUndefined()
  })
})

// Drive the real App -> frame -> transcript -> work log -> tool registry, with fake I/O only.
vi.mock('@hermes/shared/prompt-history', () => ({ append: () => undefined, load: () => [] }))

const sshVariables = ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY'] as const
const previousHome = process.env['HERMES_HOME']
const isolatedHome = mkdtempSync(join(tmpdir(), 'hermes-tern-lsp-results-'))
process.env['HERMES_HOME'] = isolatedHome

afterAll(() => {
  if (previousHome === undefined) {
    delete process.env['HERMES_HOME']
  } else {
    process.env['HERMES_HOME'] = previousHome
  }
  rmSync(isolatedHome, { recursive: true, force: true })
})

async function withLspApp(
  run: (h: {
    app: App
    gw: FakeGateway
    show: (payload: Record<string, unknown>, replay?: boolean) => Promise<NodeJson[]>
    shown: () => NodeJson[]
    refresh: () => Promise<void>
  }) => Promise<void>,
  ssh = false
) {
  const previous = sshVariables.map(name => process.env[name])
  for (const name of sshVariables) {
    delete process.env[name]
  }
  if (ssh) {
    process.env['SSH_CONNECTION'] = 'remote client'
  }

  const gw = new FakeGateway()
  gw.attached = false
  const tern = fakeTern({ draws: true })
  const app = new App(tern.session, gw.client, 'fixture')
  const running = app.run()
  given.session(app, 'lsp-session')
  given.info(app, { cwd: '/project', model: 'fixture', terminal_backend: 'local' })

  const shown = () => topNodes(tern.region('main')).flatMap(n => nodes(n.toJSON()))
  const refresh = async () => { app.changed(); await settle(gw) }
  const show = async (payload: Record<string, unknown>, replay = false): Promise<NodeJson[]> => {
    if (replay) {
      app.transcript.load([
        { role: 'user', text: 'Inspect project' },
        { role: 'tool', name: 'lsp', tool_call_id: 'lsp1',
          args: { operation: 'references' }, content: JSON.stringify(payload) }
      ])
    } else {
      app.transcript.toolStart({ name: 'lsp', tool_id: 'lsp1', args: { operation: 'references' } }, 1)
      app.transcript.toolComplete({ name: 'lsp', tool_id: 'lsp1', result: payload }, 2)
      app.transcript.complete({ status: 'complete', text: '' }, 3)
    }
    await refresh()
    return shown()
  }

  try {
    await run({ app, gw, show, shown, refresh })
  } finally {
    app.quit()
    tern.end()
    await running
    sshVariables.forEach((name, index) => {
      const value = previous[index]
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    })
  }
}

const appRole = (list: NodeJson[], name: string) => list.filter(n => n.p?.['role'] === name)

describe('LSP app render authority and cache transitions', () => {
  it('produces local live and stored hrefs through the real App work-log path', async () => {
    await withLspApp(async h => {
      const expected = [
        'file:///project/src/a.py#L2-L4',
        'file:///project/src/a.py#L2-L4',
        'file:///project/src/b.py#L2-L4'
      ]
      expect(appRole(await h.show(referencePayload), 'omp.tool.reference')
        .map(n => n.p?.['href'])).toEqual(expected)
      expect(appRole(await h.show(referencePayload, true), 'omp.tool.reference')
        .map(n => n.p?.['href'])).toEqual(expected)

      const symbols = envelope({ kind: 'symbols', symbols: [symbol('outer', 'Outer', [symbol('inner', 'method')])] })
      const replayed = await h.show(symbols, true)
      expect(appRole(replayed, 'omp.tool.symbols')[0]?.p?.['nodes']).toMatchObject([{
        children: [{ label: [{ href: 'file:///project/src/a.py#L2-L4' }, {}] }]
      }])
    })
  })

  it('revokes unchanged-turn hrefs for attached, remote and SSH transitions, then scopes to new cwd', async () => {
    await withLspApp(async h => {
      await h.show(referencePayload, true)
      const expected = 'file:///project/src/a.py#L2-L4'
      expect(appRole(h.shown(), 'omp.tool.reference')[0]?.p?.['href']).toBe(expected)

      h.gw.attached = true
      await h.refresh()
      expect(appRole(h.shown(), 'omp.tool.reference')[0]?.p?.['href']).toBeUndefined()
      h.gw.attached = false
      given.info(h.app, { cwd: '/project', model: 'fixture', terminal_backend: 'ssh' })
      await h.refresh()
      expect(appRole(h.shown(), 'omp.tool.reference')[0]?.p?.['href']).toBeUndefined()
      expect(appRole(h.shown(), 'omp.tool.notice')[0]?.p?.['spans']).toEqual([
        { s: 'muted', t: 'File targets are not confirmed host-local; links disabled.' }
      ])

      given.info(h.app, { cwd: '/another folder', model: 'fixture', terminal_backend: 'local' })
      await h.refresh()
      expect(appRole(h.shown(), 'omp.tool.reference')[0]?.p?.['href'])
        .toBe('file:///another%20folder/src/a.py#L2-L4')
      given.info(h.app, { cwd: '/project', model: 'fixture', terminal_backend: 'local' })
      await h.refresh()
      expect(appRole(h.shown(), 'omp.tool.reference')[0]?.p?.['href']).toBe(expected)

      process.env['SSH_CLIENT'] = 'remote client'
      await h.refresh()
      expect(appRole(h.shown(), 'omp.tool.reference')[0]?.p?.['href']).toBeUndefined()
      delete process.env['SSH_CLIENT']
      await h.refresh()
      expect(appRole(h.shown(), 'omp.tool.reference')[0]?.p?.['href']).toBe(expected)
    })
  })

  it('refuses an unknown backend, a missing active session and SSH stored-result replay', async () => {
    await withLspApp(async h => {
      await h.show(referencePayload, true)
      given.info(h.app, { cwd: '/project', model: 'fixture' })
      await h.refresh()
      expect(appRole(h.shown(), 'omp.tool.reference')[0]?.p?.['href']).toBeUndefined()
      given.info(h.app, { cwd: '/project', model: 'fixture', terminal_backend: 'local' })
      h.app.session.ref = { live: null, stored: null }
      await h.refresh()
      expect(appRole(h.shown(), 'omp.tool.reference')[0]?.p?.['href']).toBeUndefined()
    })
    await withLspApp(async h => {
      expect(appRole(await h.show(referencePayload, true), 'omp.tool.reference')[0]?.p?.['href'])
        .toBeUndefined()
    }, true)
  })
})

/** Exercise the real parser -> typed registry -> Tern tree (not source-string matching). */
const companion = {
  diff: '@@ -1 +1 @@\n-old\n+new',
  lsp_diagnostics: 'Legacy errors must not shadow the structured companion',
  lsp_diagnostics_data: [
    {
      path: 'src/a.py',
      status: 'ok',
      diagnostics: [
        { col: 3, end_col: 5, end_line: 4, line: 2, message: 'Undefined name', severity: 'error', source: 'pyright' },
        { col: 8, line: 7, message: 'Unused value', severity: 'warn' },
        { col: 2, line: 10, message: 'Informational', severity: 'info' },
        { col: 1, line: 12, message: 'Try this', severity: 'hint' }
      ],
      omitted: 2
    },
    { path: 'src/b.py', status: 'ok', diagnostics: [{ col: 1, line: 8, message: 'Mismatch', severity: 'error' }] }
  ]
}

describe('patch and write_file LSP companion diagnostics', () => {
  it.each(['patch', 'write_file'] as const)('retains severity, source and full available range in %s live/stored cards', name => {
    for (const result of [companion, JSON.stringify(companion)]) {
      const c = call(name, { content: 'new', path: 'src/a.py' }, { result })
      expect(detailOf(c)).toMatchObject({
        diagnostics: { files: [
          { path: 'src/a.py', diagnostics: [
            { col: 3, line: 2, end: { line: 4, col: 5 }, message: 'Undefined name', severity: 'error', source: 'pyright' },
            { col: 8, line: 7, message: 'Unused value', severity: 'warn' },
            { col: 2, line: 10, message: 'Informational', severity: 'info' },
            { col: 1, line: 12, message: 'Try this', severity: 'hint' }
          ], omitted: 2 },
          { path: 'src/b.py', diagnostics: [
            { col: 1, line: 8, message: 'Mismatch', severity: 'error' }
          ], omitted: 0 }
        ] }
      })
      const root = tree(toolNode(c, 12, local))
      expect(role(root, 'omp.tool.diagnostics')).toHaveLength(1)
      expect(role(root, 'omp.tool.diagnostics')[0]?.p?.['head'])
        .toEqual([{ s: 'chip', t: '2 errors · 1 warning · 1 info · 1 hint' }])
      expect(role(root, 'omp.tool.diagnostics.file')).toHaveLength(2)
      expect(role(root, 'omp.tool.diagnostic').map(n => n.p?.['href'])).toEqual([
        'file:///project/src/a.py#L2-L4',
        'file:///project/src/a.py#L7C8',
        'file:///project/src/a.py#L10C2',
        'file:///project/src/a.py#L12C1',
        'file:///project/src/b.py#L8C1'
      ])
      expect(role(root, 'omp.tool.diagnostic.error')).toHaveLength(2)
      expect(role(root, 'omp.tool.diagnostic.warn')[0]?.p?.['spans']).toEqual([{ s: 'warning', t: '▲' }])
      expect(role(root, 'omp.tool.diagnostic.info')).toHaveLength(1)
      expect(role(root, 'omp.tool.diagnostic.hint')).toHaveLength(1)
      expect(role(root, 'omp.tool.diagnostic')[0]?.p?.['role']).toBe('omp.tool.diagnostic')
      expect(nodes(root).map(n => n.p?.['spans']))
        .toContainEqual([{ s: 'muted mono', t: '2:3–4:5' }])
      expect(nodes(root).find(n => n.p?.['text'] === 'Undefined name (pyright)')).toBeDefined()
      expect(nodes(root).some(n => n.p?.['text'] === 'Legacy errors must not shadow the structured companion')).toBe(false)
      expect(role(root, 'omp.tool.notice').some(n => JSON.stringify(n.p?.['spans']).includes('2 additional diagnostics omitted'))).toBe(true)
      expect(toolDetail(c, 12, local).map(tree).flatMap(nodes)
        .filter(n => n.p?.['role'] === 'omp.tool.diagnostic')).toHaveLength(5)
    }
  })

  it.each(['patch', 'write_file'] as const)('%s refuses local links on remote or unsafe paths', name => {
    for (const result of [
      companion,
      { ...companion, lsp_diagnostics_data: [
        { path: 'https://untrusted/a.py', status: 'ok', diagnostics: [{ severity: 'error', line: 2, col: 3, message: 'untrusted' }] }
      ] }
    ]) {
      const remote = tree(toolNode(call(name, { path: 'src/a.py' }, { result }), 12, { cwd: '/project', hostLocal: false }))
      expect(role(remote, 'omp.tool.diagnostic')).not.toHaveLength(0)
      expect(role(remote, 'omp.tool.diagnostic').every(n => n.p?.['href'] === undefined)).toBe(true)
      expect(nodes(remote).filter(n => n.p?.['role'] === 'omp.tool.file').every(n => n.p?.['href'] === undefined)).toBe(true)
    }

    const bad = tree(toolNode(call(name, { path: 'src/a.py' }, { result: {
      lsp_diagnostics_data: [{
        path: 'https://untrusted/a.py', status: 'ok',
        diagnostics: [{ severity: 'error', line: 2, col: 3, message: 'unsafe' }]
      }]
    } }), 12, local))
    expect(role(bad, 'omp.tool.diagnostic')[0]?.p?.['href']).toBeUndefined()
  })

  it('keeps diagnostic rows for new writes and patch results without diff text', () => {
    const data = { lsp_diagnostics_data: [
      { path: 'src/new.py', status: 'ok', diagnostics: [{ severity: 'error', line: 2, col: 4, message: 'New file issue' }] }
    ] }
    const write = tree(toolNode(call('write_file', { path: 'src/new.py', content: 'line one\nline two\n' }, {
      result: { ...data, diff: '@@ -0,0 +1,2 @@\n+line one\n+line two' }
    }), 2, local))
    expect(nodes(write).some(n => n.k === 'code' && n.p?.['numbers'] === true)).toBe(true)
    expect(role(write, 'omp.tool.diagnostic')).toHaveLength(1)
    const patch = tree(toolNode(call('patch', { path: 'src/new.py' }, { result: data }), 2, local))
    expect(role(patch, 'omp.tool.diagnostic')).toHaveLength(1)
  })

  it.each(['patch', 'write_file'] as const)('%s retains malformed and legacy text without claiming structured results', name => {
    for (const result of [
      { lsp_diagnostics: 'Old LSP report' },
      { lsp_diagnostics: 'Old LSP report', lsp_diagnostics_data: [
        { path: 'src/a.py', status: 'ok', diagnostics: [{ severity: 'error', line: -1, col: 1, message: 'bad' }] }
      ] },
      { lsp_diagnostics: 'Old LSP report', lsp_diagnostics_data: [
        { path: 'src/a.py', status: 'ok', diagnostics: [
          { severity: 'error', line: 2, col: 1, end_line: 1, end_col: 4, message: 'reversed' }
        ] }
      ] }
    ]) {
      const root = tree(toolNode(call(name, { path: 'src/a.py' }, { result }), 2, local))
      expect(role(root, 'omp.tool.diagnostics')).toHaveLength(0)
      expect(role(root, 'omp.tool.notice').map(n => n.p?.['spans']))
        .toContainEqual([{ s: 'muted', t: 'Old LSP report' }])
    }
  })

  it('keeps unavailable status as a note and never fabricates a checked error', () => {
    const root = tree(toolNode(call('write_file', { path: 'src/a.py' }, { result: {
      lsp_diagnostics_data: [{ path: 'src/a.py', status: 'unavailable', message: 'language server timed out' }]
    } }), 2, local))
    expect(root.p?.['status']).toBe('done')
    expect(role(root, 'omp.tool.diagnostics')).toHaveLength(0)
    expect(role(root, 'omp.tool.diagnostics.unavailable')[0]?.p?.['spans'])
      .toEqual([{ s: 'muted', t: 'src/a.py: language server timed out' }])
  })

  it('folds large structured diagnostics at the proven donor threshold', () => {
    const root = tree(toolNode(call('patch', { path: 'src/a.py' }, { result: {
      lsp_diagnostics_data: [{
        path: 'src/a.py', status: 'ok',
        diagnostics: Array.from({ length: 9 }, (_, i) => ({
          col: 1, line: i + 1, message: 'Issue ' + i, severity: 'error'
        }))
      }]
    } }), 2, local))
    expect(role(root, 'omp.tool.diagnostics')[0]?.p).toMatchObject({
      collapsed: true, collapsible: true, head: [{ s: 'chip', t: '9 errors' }]
    })
    expect(role(root, 'omp.tool.diagnostic')).toHaveLength(9)
  })
})
