// The file, row and reply readers of wire/files.ts and wire/sqlite.ts: each reads a valid file,
// falls back where the reader before the schema fell back, and still reads what the Python half
// writes. What the new code writes stays readable by the reader before it (an old pane runs the old
// bundle after a `git pull`): the `before*` functions below are those readers, kept as they were.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'
import * as z from 'zod/mini'

import { liveSessionId, storedSessionId } from '../core/ids.js'
import { parseStacks } from '../github/branch.js'
import { chartMemory } from '../processes/widgets/memory.js'
import { loadSettings, saveSettings } from '../settings.js'
import { readWatchSpec, WATCH_ENV, type WatchSpec } from '../watch/spec.js'
import { readJsonFile } from '../wire/files.js'
import { decodeJson } from '../wire/json.js'
import { first, rows, storedCalls, text } from '../wire/sqlite.js'

const scratch = () => mkdtempSync(join(tmpdir(), 'files-'))

/** `content` written to a new file; its path. */
function fileWith(content: string, name = 'f.json'): string {
  const file = join(scratch(), name)
  writeFileSync(file, content)

  return file
}

/** settings.ts `loadSettings` before the schema: the file's object as it is, or {}. */
function beforeLoadSettings(file: string): unknown {
  try {
    const parsed = decodeJson(readFileSync(file, 'utf8'))

    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** watch/spec.ts `readWatchSpec` before the schema: any JSON whose `sid` and `subagent` are text. */
function beforeReadWatchSpec(raw: string): unknown {
  const spec = decodeJson(raw)

  return z.object({ sid: z.string(), subagent: z.string() }).safeParse(spec).success ? spec : undefined
}

describe('settings.json', () => {
  it('reads a valid file', () => {
    expect(loadSettings(fileWith('{"theme":"nous","thoughts":false,"jobCharts":true}'))).toEqual({ jobCharts: true, theme: 'nous', thoughts: false })
  })

  it('reads a missing field as unset, and a missing file or text that is not JSON as no settings', () => {
    expect(loadSettings(fileWith('{"thoughts":false}'))).toEqual({ thoughts: false })
    expect(loadSettings(join(scratch(), 'none.json'))).toEqual({})
    expect(loadSettings(fileWith('{"theme":'))).toEqual({})
    expect(loadSettings(fileWith('[1, 2]'))).toEqual({})
  })

  it('reads {"theme": 42} as no theme: the Tern palette, which 42 drew before the schema too', () => {
    const settings = loadSettings(fileWith('{"theme":42,"thoughts":false}'))

    expect(settings).toEqual({ thoughts: false })
    expect(settings.theme ?? 'tern').toBe('tern')
  })

  it('saves into what the file holds, so the reader before the schema reads the new file', () => {
    const file = fileWith('{"theme":42,"extra":{"kept":true}}')

    expect(saveSettings({ theme: 'skin' }, file)).toEqual({ theme: 'skin' })
    expect(beforeLoadSettings(file)).toEqual({ extra: { kept: true }, theme: 'skin' })
    expect(loadSettings(file)).toEqual({ theme: 'skin' })
  })
})

describe('the watch spec', () => {
  const spec: WatchSpec = {
    goal: 'Survey the repo',
    index: 2,
    log: '/tmp/a.log',
    name: 'scout',
    sid: liveSessionId('live-1'),
    startedAt: 1_700_000_000_000,
    stored: storedSessionId('stored-1'),
    subagent: 'sa-1'
  }

  it('reads a valid spec, and the reader before the schema reads the same text', () => {
    const raw = JSON.stringify(spec)

    expect(readWatchSpec({ [WATCH_ENV]: raw })).toEqual(spec)
    expect(beforeReadWatchSpec(raw)).toEqual(spec)
  })

  it('needs the session and the subagent; a missing name or goal reads as empty', () => {
    expect(readWatchSpec({ [WATCH_ENV]: JSON.stringify({ ...spec, subagent: undefined }) })).toBeUndefined()
    expect(readWatchSpec({ [WATCH_ENV]: JSON.stringify({ sid: 'live-1', subagent: 'sa-1' }) })).toMatchObject({ goal: '', name: '', sid: 'live-1', subagent: 'sa-1' })
  })

  it('reads no spec from an unset variable, text that is not JSON, or null', () => {
    expect(readWatchSpec({})).toBeUndefined()
    expect(readWatchSpec({ [WATCH_ENV]: '{"sid":' })).toBeUndefined()
    expect(readWatchSpec({ [WATCH_ENV]: 'null' })).toBeUndefined()
  })
})

describe('stack layers', () => {
  it('skips a layer with no number', () => {
    expect(parseStacks('github.com', 'a/b', [{ number: 4, pull_requests: [{ head: { ref: 'x' } }, { number: 9 }] }])[0]?.layers).toEqual([{ head: '', number: 9, state: 'open' }])
  })

  it('throws for a null layer, as reading its number did before the schema', () => {
    expect(() => parseStacks('github.com', 'a/b', [{ number: 4, pull_requests: [null, { number: 9 }] }])).toThrow(TypeError)
  })
})

describe('chart memory', () => {
  it('reads a kept decline and kept rules, and the reader before the schema reads what it saves', () => {
    const dir = join(scratch(), 'charts')
    const memory = chartMemory(dir)
    memory.save('proc_1', { skip: 40 })

    expect(memory.load('proc_1')).toEqual({ skip: 40 })
    expect(readJsonFile(join(dir, 'proc_1.json'))).toEqual({ skip: 40 })
  })

  it('reads nothing from a missing file, text that is not JSON, or rules that do not check', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'bad.json'), '{"skip":')
    writeFileSync(join(dir, 'rules.json'), '{"rules":[]}')

    expect(chartMemory(dir).load('none')).toBeUndefined()
    expect(chartMemory(dir).load('bad')).toBeUndefined()
    expect(chartMemory(dir).load('rules')).toBeUndefined()
  })
})

describe('SQLite rows', () => {
  const db = () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec("CREATE TABLE t (id TEXT, n REAL); INSERT INTO t VALUES ('a', 1), (NULL, 2), ('c', NULL)")

    return conn
  }

  it('reads each row through its schema and skips a row it cannot read', () => {
    const row = z.object({ id: z.string(), n: z.nullable(z.number()) })

    expect(rows(db().prepare('SELECT id, n FROM t ORDER BY rowid'), row)).toEqual([
      { id: 'a', n: 1 },
      { id: 'c', n: null }
    ])
  })

  it('reads the first row, or none', () => {
    const row = z.object({ id: text })

    expect(first(db().prepare('SELECT id FROM t WHERE n = ?'), row, 2)).toEqual({ id: null })
    expect(first(db().prepare('SELECT id FROM t WHERE n = ?'), row, 9)).toBeUndefined()
  })

  it("reads a row's tool calls; none for NULL or text that is not a list, and a null call throws as before", () => {
    expect(storedCalls('[{"id":"c1","function":{"name":"terminal","arguments":"{}"}},5]')).toEqual([
      { function: { arguments: '{}', name: 'terminal' }, id: 'c1' },
      {}
    ])
    expect(storedCalls(null)).toEqual([])
    expect(storedCalls('{"id":"c1"}')).toEqual([])
    expect(storedCalls('[{')).toEqual([])
    expect(() => storedCalls('[null]')).toThrow(TypeError)
  })
})
