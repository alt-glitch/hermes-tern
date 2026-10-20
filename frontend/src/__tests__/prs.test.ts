import { plain } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { prKey, storedSessionId } from '../core/ids.js'
import type { BranchTarget } from '../github/branch.js'
import type { PrRef } from '../github/pullRequest.js'
import { type Entry, PullRequests } from '../github/store.js'
import { parseBody } from '../prs/body.js'
import { PrView } from '../prs/view.js'

const text = (nodes: unknown[]) => plain({ main: nodes } as never, 200)

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

    const md = (part as { text: string }).text

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
  const pr = {
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
    const prs = { activity: vi.fn(async () => {}), busy: () => false, entries: () => [entry], files: vi.fn(async () => {}), get: () => entry, poke: vi.fn() }
    const view = new PrView({ changed: vi.fn(), notice: vi.fn(), open: vi.fn(), prs: prs as unknown as PullRequests }, prKey(ref))

    return { prs, view }
  }

  it('shows the description, then says the conversation is loading, or why it failed', () => {
    const entry = { activity: { kind: 'idle' }, files: { kind: 'idle' }, pr, ref, source: 'linked' } as Entry
    const { prs, view } = viewOf(entry)

    expect(text(view.body('b', 0))).toContain('Fixes it.')
    expect(text(view.body('b', 0))).toContain('Reading the conversation…')
    expect(prs.activity).toHaveBeenCalled()
    expect(text(viewOf({ ...entry, activity: { error: 'GitHub answered 502', failedAt: 0, kind: 'failed' } }).view.body('b', 0))).toContain('GitHub answered 502')
  })

  it('reads the files only on the Files tab, and says why they failed', () => {
    const entry = { activity: { kind: 'idle' }, files: { error: 'timeout', failedAt: 0, kind: 'failed' }, pr, ref, source: 'linked' } as Entry
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
    const entry = {
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
    } as Entry
    const out = text(viewOf(entry).view.body('b', Date.parse('2026-10-19T10:05:00Z')))

    expect(out).toContain('sid added 2 commits')
    expect(out).toContain('1111111')
    expect(out).toContain('ana approved these changes')
  })

  it("shows a linked PR as 'Reading GitHub…' with its repository and number before the first read settles", () => {
    // The round waits on the branch lookup, so nothing has been read or stored yet.
    const branchOf = () => new Promise<BranchTarget | undefined>(() => {})
    const graphql = vi.fn(async () => ({}))
    const prs = new PullRequests({ changed: vi.fn(), cwd: () => '/repo', sid: () => storedSessionId('s1') }, { graphql, rest: vi.fn() }, () => [ref], branchOf)
    const view = new PrView({ changed: vi.fn(), notice: vi.fn(), open: vi.fn(), prs }, prKey(ref))

    prs.adopt()
    expect(prs.get(prKey(ref))).toMatchObject({ ref })
    expect(prs.get(prKey(ref))?.pr).toBeUndefined()
    expect(view.selection()?.key).toBe(prKey(ref))
    expect(text(view.body('b', 0))).toContain('Reading GitHub…')
    expect(text([view.header(0)])).toContain('acme/app #5')
    expect(graphql).not.toHaveBeenCalled()
    prs.dispose()
  })
})
