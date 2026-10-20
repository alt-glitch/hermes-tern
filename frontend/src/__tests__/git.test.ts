import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { applyNumstat, fileDiff, gitState, parseStatus } from '../git/status.js'

import { must } from './fakes.js'

describe('git status', () => {
  it('reads the branch, its distance from upstream and every kind of change', () => {
    const s = parseStatus(
      [
        '# branch.oid 1234',
        '# branch.head feat/x',
        '# branch.upstream origin/feat/x',
        '# branch.ab +2 -1',
        '1 .M N... 100644 100644 100644 aaa bbb src/a.ts',
        '1 A. N... 000000 100644 100644 000 ccc src/new file.ts',
        '2 R. N... 100644 100644 100644 ddd eee R100 src/b.ts',
        'src/old.ts',
        'u UU N... 100644 100644 100644 100644 f1 f2 f3 src/c.ts',
        '? notes.md',
        '? ü "q".txt',
        ''
      ].join('\0')
    )

    expect([s.branch, s.upstream, s.ahead, s.behind]).toEqual(['feat/x', 'origin/feat/x', 2, 1])
    expect(s.files.map(f => `${f.status}:${f.path}${f.from ? `<${f.from}` : ''}${f.staged ? ':staged' : ''}`)).toEqual([
      'modified:src/a.ts',
      'added:src/new file.ts:staged',
      'renamed:src/b.ts<src/old.ts:staged',
      'conflicted:src/c.ts',
      'untracked:notes.md',
      'untracked:ü "q".txt'
    ])
    expect(parseStatus('# branch.head (detached)\0').branch).toBeUndefined()
  })

  it('puts numstat counts on files, renames and new files included', () => {
    const files = parseStatus(['1 .M N... 1 1 1 a b src/a.ts', '2 R. N... 1 1 1 d e R100 src/b.ts', 'src/old.ts', '? n.md', ''].join('\0')).files

    applyNumstat(files, ['3\t1\tsrc/a.ts', '4\t2\t', 'src/old.ts', 'src/b.ts', '-\t-\timg.png', ''].join('\0'))
    applyNumstat(files, ['2\t0\t', '/dev/null', 'n.md', ''].join('\0'))

    expect(files.map(f => [f.path, f.additions, f.deletions])).toEqual([
      ['src/a.ts', 3, 1],
      ['src/b.ts', 4, 2],
      ['n.md', 2, 0]
    ])
  })

  it('reads a real checkout: a non-ASCII name and a rename out of a folder keep their path and lines', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tern-git-'))
    const g = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
    g('init', '-q')
    mkdirSync(join(root, 'd', 'sub'), { recursive: true })
    writeFileSync(join(root, 'd', 'sub', 'f.txt'), 'x\ny\n')
    writeFileSync(join(root, 'ü.txt'), 'a\n')
    g('add', '-A')
    g('commit', '-qm', 'init')
    g('mv', 'd/sub/f.txt', 'd/f.txt')
    writeFileSync(join(root, 'd', 'f.txt'), 'x\ny\nz\n')
    g('add', '-A')
    writeFileSync(join(root, 'ü.txt'), 'a\nb\n')
    writeFileSync(join(root, 'ñew.txt'), '1\n2\n')

    const state = await gitState(root)
    const byPath = new Map(state?.files.map(f => [f.path, f]))

    expect([...byPath.keys()].sort()).toEqual(['d/f.txt', 'ñew.txt', 'ü.txt'])
    expect(byPath.get('d/f.txt')).toMatchObject({ additions: 1, deletions: 0, from: 'd/sub/f.txt', status: 'renamed' })
    expect(byPath.get('ü.txt')).toMatchObject({ additions: 1, deletions: 0, status: 'modified' })
    expect(byPath.get('ñew.txt')).toMatchObject({ additions: 2, status: 'untracked' })
    expect(await fileDiff(must(state).root, must(byPath.get('ü.txt')))).toContain('+b')
  })
})
