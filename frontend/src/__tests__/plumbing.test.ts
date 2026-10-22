// The shared plumbing both panes run on: the render scheduler, the disposables, the launch
// environment, the input loop, the surface host, the OSC writes and the sheets' ticker.
import { hostname } from 'node:os'

import type { Key, SessionInput, TspEvent } from '@stencil-hq/tern'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { launchEnv, readLaunchEnv } from '../config/env.js'
import { Disposables } from '../core/disposables.js'
import { RenderScheduler } from '../core/scheduler.js'
import { tickWhileOpen } from '../overlays/sheet.js'
import { INPUT_ID, SurfaceHost } from '../surface/host.js'
import { runInput } from '../surface/input.js'
import { reportCwd, setTabTitle } from '../surface/osc.js'
import { STYLES } from '../view/styles.js'

import { fakeTern, key } from './fakes.js'

const turn = () => new Promise(resolve => setImmediate(resolve))

afterEach(() => {
  vi.useRealTimers()
})

describe('RenderScheduler', () => {
  it('renders once for every request made before the next turn', async () => {
    const render = vi.fn()
    const renders = new RenderScheduler(render)

    renders.request()
    renders.request()
    renders.request()
    expect(render).not.toHaveBeenCalled()

    await turn()
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('takes a new request once the render ran', async () => {
    const render = vi.fn()
    const renders = new RenderScheduler(render)

    renders.request()
    await turn()
    renders.request()
    await turn()

    expect(render).toHaveBeenCalledTimes(2)
  })

  it('a request made while rendering schedules the next render', async () => {
    let count = 0
    const renders: RenderScheduler = new RenderScheduler(() => {
      count++

      if (count === 1) {
        renders.request()
      }
    })

    renders.request()
    await turn()
    await turn()

    expect(count).toBe(2)
  })
})

describe('Disposables', () => {
  it('runs the teardowns once, the newest first', () => {
    const order: string[] = []
    const owned = new Disposables()
    owned.add(() => order.push('a'))
    owned.add(() => order.push('b'))
    owned.add(() => order.push('c'))

    owned.dispose()
    owned.dispose()

    expect(order).toEqual(['c', 'b', 'a'])
    expect(owned.disposed).toBe(true)
  })

  it('drops a teardown that ended on its own, and runs one added late at once', () => {
    const order: string[] = []
    const owned = new Disposables()
    const drop = owned.add(() => order.push('dropped'))
    owned.add(() => order.push('kept'))

    drop()
    owned.dispose()
    owned.add(() => order.push('late'))

    expect(order).toEqual(['kept', 'late'])
  })

  it('runs every teardown when one throws, then throws the first error', () => {
    const order: string[] = []
    const owned = new Disposables()
    owned.add(() => order.push('first'))
    owned.add(() => {
      throw new Error('second')
    })
    owned.add(() => {
      throw new Error('third')
    })

    expect(() => owned.dispose()).toThrow('third')
    expect(order).toEqual(['first'])
  })

  it('clears a timeout that has not fired, and forgets one that has', () => {
    vi.useFakeTimers()
    const owned = new Disposables()
    const fired = vi.fn()
    owned.timeout(fired, 100)
    owned.timeout(fired, 1000)

    vi.advanceTimersByTime(100)
    expect(fired).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)

    owned.dispose()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(fired).toHaveBeenCalledTimes(1)
  })
})

describe('readLaunchEnv', () => {
  it('reads every launch variable, trimming the ones the launcher passes through', () => {
    const env = readLaunchEnv(
      {
        HERMES_CWD: '/work',
        HERMES_PYTHON_SRC_ROOT: '/src/hermes',
        HERMES_TERN_EVENT_LOG: '/tmp/events.jsonl',
        HERMES_TERN_LAUNCH_CWD: '/home/me/project',
        HERMES_TERN_RESTORED: 'root-1',
        HERMES_TUI_CWD: ' /work/tree ',
        HERMES_TUI_IMAGE: ' /tmp/shot.png\n',
        HERMES_TUI_QUERY: '  what is this?  ',
        HERMES_TUI_RESUME: ' 20260101_abc ',
        HERMES_VERSION: '0.9.0',
        HOME: '/home/me',
        TERN_PANE: ' 34505767256143 '
      },
      '/elsewhere'
    )

    expect(env).toEqual({
      cwd: '/work',
      eventLog: '/tmp/events.jsonl',
      home: '/home/me',
      image: '/tmp/shot.png',
      pane: '34505767256143',
      paneCwd: '/home/me/project',
      pythonSrcRoot: '/src/hermes',
      query: 'what is this?',
      restored: true,
      resume: '20260101_abc',
      sessionCwd: '/work/tree',
      version: '0.9.0'
    })
    expect(Object.isFrozen(env)).toBe(true)
  })

  it('gives empty strings for unset variables, the process folder for the cwd, and HOME as set', () => {
    expect(readLaunchEnv({}, '/elsewhere')).toEqual({
      cwd: '/elsewhere',
      eventLog: '',
      home: undefined,
      image: '',
      pane: '',
      paneCwd: '/elsewhere',
      pythonSrcRoot: '',
      query: '',
      restored: false,
      resume: '',
      sessionCwd: '',
      version: ''
    })
    // An empty HERMES_CWD is no folder; an empty HOME stays as set.
    expect(readLaunchEnv({ HERMES_CWD: '', HOME: '' }, '/elsewhere')).toMatchObject({ cwd: '/elsewhere', home: '' })
  })

  it('reads the process environment once', () => {
    expect(launchEnv()).toBe(launchEnv())
  })
})

/** A Tern session's input as an async iterable: `items`, then `end` (a throw, or the end). */
async function* inputs(items: SessionInput[], end?: Error): AsyncGenerator<SessionInput> {
  for (const item of items) {
    await Promise.resolve()
    yield item
  }

  if (end) {
    throw end
  }
}

describe('runInput', () => {
  const focus: TspEvent = { ev: 'focus', id: INPUT_ID, raw: {}, sf: 'hermes' }

  it('hands each key and event on, and calls after() after each', async () => {
    const seen: string[] = []

    await runInput(inputs([{ key: key('a'), type: 'key' }, { event: focus, type: 'event' }]), {
      after: () => seen.push('after'),
      onEvent: ev => seen.push(`event ${ev.ev}`),
      onKey: (k: Key) => seen.push(`key ${k.name}`)
    })

    expect(seen).toEqual(['key a', 'after', 'event focus', 'after'])
  })

  it('resolves when the input fails, telling onError when it is set', async () => {
    const onError = vi.fn()
    const handlers = { after: () => undefined, onEvent: () => undefined, onKey: () => undefined }

    await runInput(inputs([], new Error('tty gone')), { ...handlers, onError })
    await expect(runInput(inputs([], new Error('quiet')), handlers)).resolves.toBeUndefined()

    expect(onError).toHaveBeenCalledWith(new Error('tty gone'))
  })
})

describe('SurfaceHost', () => {
  it('opens the chat surface, as the chat and the subagent pane both draw it', () => {
    const tern = fakeTern({ draws: true })
    const host = new SurfaceHost(tern.session, 'agent 1', STYLES)

    expect(tern.opened).toEqual([{ id: 'hermes', mode: 'inline', role: 'omp.session', title: 'agent 1' }])
    expect(host.closed).toBe(false)
  })

  it('sends the caret when it moves, and always when asked outright', () => {
    const tern = fakeTern({ draws: true })
    const host = new SurfaceHost(tern.session, 'hermes', STYLES)

    host.follow(INPUT_ID)
    expect(tern.focused).toEqual([])

    host.follow('layer.sheet.input')
    host.follow('layer.sheet.input')
    expect(tern.focused).toEqual(['layer.sheet.input'])

    host.focus(INPUT_ID)
    host.focus(INPUT_ID)
    host.follow(INPUT_ID)
    expect(tern.focused).toEqual(['layer.sheet.input', INPUT_ID, INPUT_ID])
  })
})

describe('OSC writes', () => {
  it('names the tab, with control characters as spaces', () => {
    const out = { write: vi.fn(() => true) }
    setTabTitle('fix\u0007the\nbuild', out)

    expect(out.write).toHaveBeenCalledWith('\x1b]2;fix the build\x07')
  })

  it('reports the folder as a file URL', () => {
    const out = { write: vi.fn(() => true) }
    reportCwd('/work/my tree', out)

    expect(out.write).toHaveBeenCalledWith(`\x1b]7;file://${hostname()}/work/my%20tree\x07`)
  })
})

describe('tickWhileOpen', () => {
  it('re-renders every tick until stopped', () => {
    vi.useFakeTimers()
    const host = { changed: vi.fn() }
    const stop = tickWhileOpen(host, 1000)

    vi.advanceTimersByTime(2500)
    expect(host.changed).toHaveBeenCalledTimes(2)

    stop()
    vi.advanceTimersByTime(5000)
    expect(host.changed).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
