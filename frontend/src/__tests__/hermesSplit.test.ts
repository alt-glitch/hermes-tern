import { execFile } from 'node:child_process'

import { describe, expect, it, vi } from 'vitest'

import { openHermesSplit } from '../watch/spec.js'

import { must } from './fakes.js'

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_file: string, _args: string[], done: (e: Error | null, out: { stdout: string }) => void) =>
    done(null, { stdout: 'split b7' })
  )
}))

const env = { HERMES_HOME: '/h', HERMES_PYTHON: '/venv/python', HERMES_PYTHON_SRC_ROOT: '/src', TERN_PANE: 'b3' }

describe('openHermesSplit', () => {
  it('runs `hermes <args>` in a kept-open split below this pane', async () => {
    expect(await openHermesSplit(['update'], '/repo', env)).toBe(true)
    expect(must(vi.mocked(execFile).mock.lastCall).slice(0, 2)).toEqual([
      'tern',
      [
        'split',
        'b3',
        'down',
        '--cwd',
        '/repo',
        '--keep-open',
        '--',
        'env',
        'PYTHONPATH=/src',
        'HERMES_HOME=/h',
        '/venv/python',
        '-m',
        'hermes_cli.main',
        'update'
      ]
    ])
  })

  it('is false outside a Tern pane, running nothing', async () => {
    vi.mocked(execFile).mockClear()

    expect(await openHermesSplit(['update'], '/repo', { ...env, TERN_PANE: undefined })).toBe(false)
    expect(execFile).not.toHaveBeenCalled()
  })
})
