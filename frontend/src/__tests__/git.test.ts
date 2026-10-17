import { describe, expect, it } from 'vitest'

import { applyNumstat, parseStatus } from '../git/status.js'

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
        '2 R. N... 100644 100644 100644 ddd eee R100 src/b.ts\tsrc/old.ts',
        'u UU N... 100644 100644 100644 100644 f1 f2 f3 src/c.ts',
        '? notes.md'
      ].join('\n')
    )

    expect([s.branch, s.upstream, s.ahead, s.behind]).toEqual(['feat/x', 'origin/feat/x', 2, 1])
    expect(s.files.map(f => `${f.status}:${f.path}${f.from ? `<${f.from}` : ''}${f.staged ? ':staged' : ''}`)).toEqual([
      'modified:src/a.ts',
      'added:src/new file.ts:staged',
      'renamed:src/b.ts<src/old.ts:staged',
      'conflicted:src/c.ts',
      'untracked:notes.md'
    ])
    expect(parseStatus('# branch.head (detached)').branch).toBeUndefined()
  })

  it('puts numstat counts on files, renames and new files included', () => {
    const files = parseStatus(['1 .M N... 1 1 1 a b src/a.ts', '2 R. N... 1 1 1 d e R100 src/b.ts\tsrc/old.ts', '? n.md'].join('\n')).files

    applyNumstat(files, ['3\t1\tsrc/a.ts', '0\t0\tsrc/{old.ts => b.ts}', '-\t-\timg.png'].join('\n'))
    applyNumstat(files, '2\t0\t/dev/null => n.md')

    expect(files.map(f => [f.path, f.additions, f.deletions])).toEqual([
      ['src/a.ts', 3, 1],
      ['src/b.ts', 0, 0],
      ['n.md', 2, 0]
    ])
  })
})
