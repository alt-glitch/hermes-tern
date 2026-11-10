import { Node, plain } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { liveSessionId, prKey } from '../core/ids.js'
import type { BranchTarget } from '../github/branch.js'
import type { PrRef, PullRequest } from '../github/pullRequest.js'
import { type Entry, type Listed, PullRequests } from '../github/store.js'
import { parseBody } from '../prs/body.js'
import { PrView } from '../prs/view.js'

import { key, must, ofKind, stub } from './fakes.js'

const text = (nodes: unknown[]) => plain(stub({ main: nodes }), 200)

describe('parseBody', () => {
  it('drops HTML comments and turns HTML into the Markdown it means', () => {
    const parts = parseBody('<!-- greptile_summary -->\n<h2>Score: 5/5</h2>\n\n<b>Safe</b> to merge, see <a href="https://x.dev/a">this</a>.')

    expect(parts).toEqual([{ kind: 'md', text: '## Score: 5/5\n\n**Safe** to merge, see [this](https://x.dev/a).' }])
  })

  it('reads a badge link as its words, a dot between badges', () => {
    const [part] = parseBody(
      '<h2><a href="https://g/r"><picture><source media="(prefers-color-scheme: dark)" srcset="d.svg"><img alt="Retrigger" src="r.svg"></picture></a><a href="https://g/v"><img alt="View" src="v.svg"></a>Score</h2>'
    )

    expect(part).toEqual({ kind: 'md', text: '## [Retrigger](https://g/r) · [View](https://g/v) · Score' })
  })

  it('makes a fold of each details, nested ones too, keeping open', () => {
    const parts = parseBody('Intro\n\n<details open><summary><h3>Summary</h3></summary>\n\nBody\n\n<details><summary>Inner</summary>\n\nDeep\n\n</details>\n</details>\n\nOutro')

    expect(parts).toEqual([
      { kind: 'md', text: 'Intro' },
      {
        kind: 'details',
        open: true,
        parts: [
          { kind: 'md', text: 'Body' },
          { kind: 'details', open: false, parts: [{ kind: 'md', text: 'Deep' }], summary: 'Inner' }
        ],
        summary: 'Summary'
      },
      { kind: 'md', text: 'Outro' }
    ])
  })

  it('keeps code as written, and tables, task lists and alerts in the forms Tern draws', () => {
    const [part] = parseBody(
      'Use `<b>`:\n\n```html\n<details>x</details>\n```\n\n- [x] done\n\n> [!NOTE]\n> Heads up\n\n<table><tr><th>a</th></tr><tr><td><b>1</b></td></tr></table>'
    )

    expect(part).toMatchObject({ kind: 'md' })

    const md = ofKind(part, 'md').text

    expect(md).toContain('Use `<b>`:')
    expect(md).toContain('```html\n<details>x</details>\n```')
    expect(md).toContain('* [x] done')
    expect(md).toContain('> [!NOTE]\n> Heads up')
    expect(md).toContain('| a     |\n| ----- |\n| **1** |')
  })

  it('links #N to the repository and @login to the profile, as GitHub does, but not in code or links', () => {
    const [part] = parseBody('Fixes #12, thanks @ana-b. See `#34` and [#56](https://x.dev) or me@ana.dev.', { repo: 'https://github.com/acme/app' })

    expect(part).toEqual({
      kind: 'md',
      text: 'Fixes [#\u206012](https://github.com/acme/app/issues/12), thanks [@ana-b](https://github.com/ana-b). See `#34` and [#56](https://x.dev) or <me@ana.dev>.'
    })
  })

  it('drops script and other HTML GitHub would not render', () => {
    expect(parseBody('<script>alert(1)</script><img src=x onerror="alert(1)">ok')).toEqual([{ kind: 'md', text: '![](x)ok' }])
  })
})

describe('PrView', () => {
  const ref: PrRef = { host: 'github.com', number: 5, repository: 'acme/app', url: 'https://github.com/acme/app/pull/5' }
  const pr: PullRequest = {
    additions: 3,
    author: 'sid',
    autoMerge: null,
    base: 'main',
    behindBy: 0,
    body: 'Fixes it.',
    canUpdate: true,
    changedFiles: 1,
    checks: [],
    closedAt: null,
    createdAt: '2026-10-19T10:00:00Z',
    deletions: 1,
    draft: false,
    head: 'fix',
    headOid: 'abcdef1234',
    host: 'github.com',
    id: 'PR_1',
    labels: [],
    mergeMethods: ['squash'],
    mergeState: 'CLEAN',
    mergeable: 'mergeable',
    mergedAt: null,
    number: 5,
    repository: 'acme/app',
    reviewDecision: null,
    reviewers: [],
    state: 'open',
    title: 'Fix the thing',
    updatedAt: '2026-10-19T10:00:00Z',
    url: ref.url
  }

  const viewOf = (entry: Entry) => {
    const prs = { act: vi.fn(async () => {}), activity: vi.fn(async () => {}), busy: () => false, entries: () => [entry], files: vi.fn(async () => {}), get: () => entry, poke: vi.fn() }
    const view = new PrView({ changed: vi.fn(), notice: vi.fn(), open: vi.fn(), prs: stub<PullRequests>(prs) }, prKey(ref))

    return { prs, view }
  }

  it.each(['merge', 'close'] as const)('requires bare confirmation for PR %s and fences canceled native callbacks', action => {
    const entry: Listed = { activity: { kind: 'idle' }, files: { kind: 'idle' }, pr, ref, source: 'linked' }
    const { prs, view } = viewOf(entry)
    view.ask(action)
    const find = (node: unknown): Node | undefined => node instanceof Node
      ? node.props['key'] === 'yes' ? node : node.children.map(find).find(Boolean) : undefined
    const oldClick = must(find(view.actions())?.handlers?.onClick)
    const event = { act: 'click', ev: 'action', id: 'yes', raw: {}, sf: 'hermes' } as const
    for (const name of ['y', 'enter', 'n', 'escape']) {
      for (const mods of [{ ctrl: true }, { alt: true }, { meta: true }, { shift: true }, { ctrl: true, alt: true }]) {
        expect(view.onKey(key(name, mods))).toBe(true)
      }
    }
    expect(prs.act).not.toHaveBeenCalled()
    view.onKey(key('n'))
    oldClick(event)
    expect(prs.act).not.toHaveBeenCalled()
    view.ask(action)
    oldClick(event)
    expect(prs.act).not.toHaveBeenCalled()
    const currentClick = must(find(view.actions())?.handlers?.onClick)
    currentClick(event)
    currentClick(event)
    expect(prs.act).toHaveBeenCalledTimes(1)
    expect(prs.act).toHaveBeenCalledWith(action, prKey(ref))
    view.ask(action)
    view.onKey(key('enter'))
    expect(prs.act).toHaveBeenCalledTimes(2)
  })

  it('does not apply an old PR confirmation to the fallback selection after a list change', () => {
    const entry: Listed = { activity: { kind: 'idle' }, files: { kind: 'idle' }, pr, ref, source: 'linked' }
    const otherRef = { ...ref, number: 6, url: 'https://github.com/acme/app/pull/6' }
    const other: Listed = { ...entry, ref: otherRef, pr: { ...pr, number: 6, url: otherRef.url } }
    const { prs, view } = viewOf(entry)
    view.ask('merge')
    const find = (node: unknown): Node | undefined => node instanceof Node
      ? node.props['key'] === 'yes' ? node : node.children.map(find).find(Boolean) : undefined
    const oldClick = must(find(view.actions())?.handlers?.onClick)
    prs.entries = () => [other]
    prs.get = () => other
    view.onKey(key('y'))
    oldClick({ act: 'click', ev: 'action', id: 'yes', raw: {}, sf: 'hermes' })
    expect(prs.act).not.toHaveBeenCalled()
  })

  it('shows the description, then says the conversation is loading, or why it failed', () => {
    const entry: Listed = { activity: { kind: 'idle' }, files: { kind: 'idle' }, pr, ref, source: 'linked' }
    const { prs, view } = viewOf(entry)

    expect(text(view.body('b', 0))).toContain('Fixes it.')
    expect(text(view.body('b', 0))).toContain('Reading the conversation…')
    expect(prs.activity).toHaveBeenCalled()
    expect(text(viewOf({ ...entry, activity: { error: 'GitHub answered 502', failedAt: 0, kind: 'failed' } }).view.body('b', 0))).toContain('GitHub answered 502')
  })

  it('reads the files only on the Files tab, and says why they failed', () => {
    const entry: Listed = { activity: { kind: 'idle' }, files: { error: 'timeout', failedAt: 0, kind: 'failed' }, pr, ref, source: 'linked' }
    const { prs, view } = viewOf(entry)

    view.setTab('files')
    expect(prs.files).toHaveBeenCalled()
    expect(text(view.body('b', 0))).toContain('timeout')
    // An older list stays up while a newer read fails.
    const files = [{ additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b', path: 'a.ts', status: 'modified' }]
    const last = { at: pr.updatedAt, value: files }
    expect(text(viewOf({ ...entry, files: { error: 'timeout', failedAt: 0, kind: 'failed', last } }).view.body('b', 0))).not.toContain('timeout')
  })

  it('folds a run of commits into one line and draws a review verdict without words as a line', () => {
    const entry: Listed = {
      activity: {
        at: pr.updatedAt,
        kind: 'ready',
        value: [
          { at: '2026-10-19T10:01:00Z', author: 'sid', body: 'one', kind: 'commit', url: 'https://github.com/acme/app/commit/1111111aaa' },
          { at: '2026-10-19T10:02:00Z', author: 'sid', body: 'two', kind: 'commit', url: 'https://github.com/acme/app/commit/2222222bbb' },
          { at: '2026-10-19T10:03:00Z', author: 'ana', body: '', kind: 'review', state: 'APPROVED' }
        ]
      },
      files: { kind: 'idle' },
      pr,
      ref,
      source: 'linked'
    }
    const out = text(viewOf(entry).view.body('b', Date.parse('2026-10-19T10:05:00Z')))

    expect(out).toContain('sid added 2 commits')
    expect(out).toContain('1111111')
    expect(out).toContain('ana approved these changes')
  })

  it("shows a linked PR as 'Reading GitHub…' with its repository and number before the first read settles", async () => {
    // The round waits on the branch lookup, so nothing has been read or stored yet.
    const branchOf = () => new Promise<BranchTarget | undefined>(() => {})
    const graphql = vi.fn(async () => ({}))
    const prs = new PullRequests({ changed: vi.fn(), cwd: () => '/repo', links: async () => [ref], sid: () => liveSessionId('s1') }, { graphql, rest: vi.fn() }, branchOf)
    const view = new PrView({ changed: vi.fn(), notice: vi.fn(), open: vi.fn(), prs }, prKey(ref))

    prs.adopt()
    await vi.waitFor(() => expect(prs.get(prKey(ref))).toMatchObject({ ref }))
    expect(prs.get(prKey(ref))?.pr).toBeUndefined()
    expect(view.selection()?.key).toBe(prKey(ref))
    expect(text(view.body('b', 0))).toContain('Reading GitHub…')
    expect(text([view.header(0)])).toContain('acme/app #5')
    expect(graphql).not.toHaveBeenCalled()
    prs.dispose()
  })
})
