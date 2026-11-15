import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { liveSessionId } from '../core/ids.js'
import { LinkedPrs } from '../prs/linked.js'
import type { PrRef } from '../prs/links.js'
import { prList, writePrList } from '../prs/listFile.js'
import { openPrs } from '../prs/open.js'
import { parseJson } from '../wire/json.js'

const A: PrRef = { host: 'github.com', number: 7, repository: 'nousresearch/hermes-agent', url: 'https://github.com/NousResearch/hermes-agent/pull/7' }
const B: PrRef = { host: 'github.com', number: 9, repository: 'alt-glitch/tern-plugins', url: 'https://github.com/alt-glitch/tern-plugins/pull/9' }

describe("the pane's list file", () => {
  it('holds what a link tool returned, in the format the prs plugin reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prs-list-'))
    const prs = new LinkedPrs({
      changed: linked => void writePrList('41', prList('stored-1', '/work', linked), dir),
      guideWritten: () => {},
      links: async () => ({ guides: {}, refs: [] }),
      sid: () => liveSessionId('live-1')
    })

    prs.onCall({ name: 'link_pull_request', outcome: { duration: 1, kind: 'done' }, result: { linked: [A, B] } })

    expect(parseJson(readFileSync(join(dir, 'panes', '41.prs.json'), 'utf8'))).toEqual({
      cwd: '/work',
      prs: [{ url: 'https://github.com/NousResearch/hermes-agent/pull/7' }, { url: 'https://github.com/alt-glitch/tern-plugins/pull/9' }],
      session_id: 'stored-1',
      title: 'This session',
      version: 1
    })
    expect(prList('stored-1', '/work', { guides: {}, refs: [A, B] }, { ref: A }, 1000)).toMatchObject({
      opened_at: 1000,
      selected: 'nousresearch/hermes-agent#7'
    })
  })

  it("carries the guides a write_review_guide returned, and asks to open that PR's guide", () => {
    const dir = mkdtempSync(join(tmpdir(), 'prs-list-'))
    const opened: PrRef[] = []
    const guide = { stops: [{ files: ['a.py'], notes: 'n', questions: [], title: 'The shim' }], summary: 's', written_at: 5 }
    const prs = new LinkedPrs({
      changed: linked => void writePrList('41', prList('stored-1', '/work', linked), dir),
      guideWritten: ref => void opened.push(ref),
      links: async () => ({ guides: {}, refs: [] }),
      sid: () => liveSessionId('live-1')
    })

    prs.onCall({
      name: 'write_review_guide',
      outcome: { duration: 1, kind: 'done' },
      result: { guides: { 'nousresearch/hermes-agent#7': guide }, linked: [A], written: 'nousresearch/hermes-agent#7' }
    })

    expect(parseJson(readFileSync(join(dir, 'panes', '41.prs.json'), 'utf8'))).toMatchObject({ guides: { 'nousresearch/hermes-agent#7': guide } })
    expect(opened).toEqual([A])
    expect(prList('stored-1', '/work', { guides: prs.guides(), refs: [...prs.entries()] }, { ref: A, tab: 'guide' }, 9)).toMatchObject({
      opened_at: 9,
      selected: 'nousresearch/hermes-agent#7',
      tab: 'guide'
    })
  })
})

describe('opening the PRs', () => {
  it('without the plugin, a review guide only says how to install it: GitHub does not show guides', async () => {
    const browsed: string[] = []
    const notices: string[] = []

    await openPrs(
      { entries: () => [A], notice: text => void notices.push(text), purpose: 'guide', writeList: () => '/data/panes/41.prs.json' },
      A,
      { browse: url => void browsed.push(url), open: async () => {}, ready: async () => false }
    )

    expect(browsed).toEqual([])
    expect(notices).toEqual(["The review guide for #7 is ready. To see it beside the chat, install Tern's PR plugin: tern plugin install github.com/alt-glitch/tern-plugins/prs"])
  })

  it('opens the list file beside the chat when Tern has the prs plugin', async () => {
    const opened: string[] = []
    const browsed: string[] = []

    await openPrs(
      { entries: () => [A, B], notice: () => {}, writeList: () => '/data/panes/41.prs.json' },
      undefined,
      { browse: url => void browsed.push(url), open: async path => void opened.push(path), ready: async () => true }
    )

    expect(opened).toEqual(['/data/panes/41.prs.json'])
    expect(browsed).toEqual([])
  })

  it('without the plugin, opens the newest PR on GitHub and says how to install the plugin', async () => {
    const browsed: string[] = []
    const notices: string[] = []

    await openPrs(
      { entries: () => [A, B], notice: text => void notices.push(text), writeList: () => '/data/panes/41.prs.json' },
      undefined,
      { browse: url => void browsed.push(url), open: async () => {}, ready: async () => false }
    )

    expect(browsed).toEqual(['https://github.com/alt-glitch/tern-plugins/pull/9'])
    expect(notices).toEqual(["Opened #9 on GitHub. To see pull requests beside the chat, install Tern's PR plugin: tern plugin install github.com/alt-glitch/tern-plugins/prs"])
  })
})
