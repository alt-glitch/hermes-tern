// The session picker (`/resume`, `/sessions`): stored conversations from the profile's state.db
// (hermes/sessionIndex.ts), scoped the way `hermes -c` scopes them. The first tab holds this
// project's sessions (the pane's repo, or its folder); All holds every local one with this
// project's first. Rows are grouped by last activity, pinned ones on top; a search ranks title,
// first prompt, folder, branch and id across the tab. The preview (sessions/detail.tsx) shows
// where the session ran, its whole id, its first prompt and last reply, and the conversation a
// page at a time (sessions/preview.ts reads it once the selection rests). Enter resumes; Tab
// switches the scope; → focuses the preview, where ↑/↓ step through it; ⌥C copies the id; ⌫ on an
// empty search deletes after a confirm.

import { basename } from 'node:path'

import type { Key, PickerGroup, ScrollTo } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import { copyToClipboard } from '../clipboard.js'
import { launchEnv } from '../config/env.js'
import { optional } from '../core/assert.js'
import { errorText } from '../core/errors.js'
import { Flash } from '../core/flash.js'
import { durable, storedSessionId } from '../core/ids.js'
import { mutateSession } from '../hermes/mutate.js'
import { inWorkspace, sessionLabel, type StoredSession, storedSessions, workspaceOf } from '../hermes/sessionIndex.js'
import { storedTranscripts, type TranscriptReader } from '../hermes/sessionTranscript.js'
import { homeTilde } from '../view/format.js'
import { rpc } from '../wire/rpc.js'

import type { Overlay } from './overlay.js'
import { editQuery, hitRuns, moveSelection, rank } from './search.js'
import { MORE, sessionDetail } from './sessions/detail.js'
import { PreviewLoader } from './sessions/preview.js'
import { dayOf, itemOf } from './sessions/rows.js'

/** What the session picker reaches of the app. */
export type SessionsHost = Pick<ChatPorts, 'changed' | 'close' | 'gw' | 'open' | 'resume' | 'reveal' | 'scroll' | 'session' | 'transcript'>

const KEY = 'sessions'
const LIMIT = 400
/** Blocks from the end of what is loaded at which the preview reads its next page. */
const NEAR_END = 3

type Tab = 'all' | 'here'

/** Opens the session picker; picking a row resumes that session. */
export function openSessionPicker(host: SessionsHost, reader: TranscriptReader = storedTranscripts()) {
  let state: 'loading' | 'ready' | 'error' = 'loading'
  let sessions: StoredSession[] = []
  let running = new Set<string>()
  let workspace = ''
  let tab: Tab = 'here'
  let query = ''
  let selected: string | undefined
  let deleting: string | null = null
  let shown: string[] = []
  /** Where the keys go: the list (and the search), or the preview's blocks. */
  let focus: 'list' | 'preview' = 'list'
  /** The focused block of the preview, and the blocks it had at the last render. */
  let block: string | undefined
  let blocks: string[] = []
  let nodeId = `layer.${KEY}`
  /** The selection the loader was last told of. */
  let told: string | undefined
  const current = durable(host.session.ref) ?? ''
  const loader = new PreviewLoader(reader, () => host.changed())
  const copied = new Flash<string>(() => host.changed())

  const load = async () => {
    state = 'loading'
    host.changed()

    const cwd = host.session.info?.cwd || launchEnv().cwd
    // The open session may have no messages yet; every other empty one is litter.
    const [key, live] = await Promise.all([
      workspaceOf(cwd),
      rpc(host.gw, 'session.list', { limit: 200 }).catch(() => ({ sessions: [] }))
    ])

    workspace = key
    // Only the shared gateway's rows say whether the session runs.
    running = new Set((live.sessions ?? []).filter(s => 'running' in s && s.running && s.id).map(s => s.id))
    sessions = storedSessions(LIMIT).filter(s => s.messages > 0 || s.id === current)
    tab = sessions.some(s => inWorkspace(s, workspace)) ? 'here' : 'all'
    selected = rows().find(s => s.id !== current)?.id ?? rows()[0]?.id
    state = 'ready'
    host.changed()
  }

  const here = (s: StoredSession) => inWorkspace(s, workspace)
  const rows = () => (tab === 'here' ? sessions.filter(here) : sessions)

  const resume = (id: string | undefined) => {
    const s = sessions.find(x => x.id === id)

    if (!s) {
      return
    }

    host.close(overlay)

    if (s.id !== current) {
      // A refusal (deleted elsewhere, gateway down) is a notice; the view stays where it was.
      host.resume(storedSessionId(s.id)).catch((error: unknown) => {
        host.transcript.notice(`Could not resume: ${errorText(error)}`, 'error')
        host.changed()
      })
    }
  }

  const remove = async (id: string) => {
    deleting = null

    try {
      // The shared gateway deletes through a revision-fenced mutation (the whole lineage).
      await (host.gw.isCanonical ? mutateSession(host.gw, id, 'delete', {}) : rpc(host.gw, 'session.delete', { session_id: id }))
      sessions = sessions.filter(s => s.id !== id)
      loader.forget(id)
    } catch (error) {
      host.transcript.notice(errorText(error), 'error')
    }

    host.changed()
  }

  const askDelete = () => {
    if (!selected) {
      return
    }

    if (selected === current) {
      host.transcript.notice('The open session cannot be deleted; start a new one first.', 'warning')
    } else {
      deleting = selected
    }
  }

  const copyId = () => {
    if (selected) {
      copyToClipboard(selected)
      copied.set(selected)
    }
  }

  const setTab = (t: Tab) => {
    tab = t
    deleting = null
    focus = 'list'
  }

  /** Focuses preview block `key`, scrolls it into view, and reads the next page when it is near the end. */
  const focusBlock = (key: string | undefined) => {
    if (!key || !selected) {
      return
    }

    focus = 'preview'
    block = key
    host.reveal(`${nodeId}.${key}`)

    if (blocks.length - blocks.indexOf(key) <= NEAR_END || key === MORE) {
      loader.more(selected)
    }

    host.changed()
  }

  const scrollPreview = (to: ScrollTo) => {
    const at = block ?? blocks[0]

    if (at) {
      host.scroll(`${nodeId}.${at}`, to)
    }
  }

  /** The preview's keys; false for one the list takes. */
  const previewKey = (k: Key): boolean => {
    const bare = !k.ctrl && !k.alt && !k.meta
    const at = block ? blocks.indexOf(block) : -1

    if (k.name === 'escape' || (bare && k.name === 'left')) {
      focus = 'list'
    } else if (bare && (k.name === 'down' || k.name === 'j')) {
      focusBlock(blocks[Math.min(blocks.length - 1, at + 1)])
    } else if (bare && (k.name === 'up' || k.name === 'k')) {
      focusBlock(blocks[Math.max(0, at - 1)])
    } else if (k.name === 'page_down' || (bare && k.name === 'space')) {
      scrollPreview('page-down')
    } else if (k.name === 'page_up') {
      scrollPreview('page-up')
    } else if (k.name === 'home') {
      focusBlock(blocks[0])
    } else if (k.name === 'end') {
      focusBlock(blocks.at(-1))
    } else if (bare && k.name === 'c') {
      copyId()
    } else {
      // Anything else (typing, ⌫) goes back to the list and its search.
      focus = 'list'

      return false
    }

    return true
  }

  const view = (now: number) => {
    // Browsing All: pinned first, then this project's, then the rest, each newest first.
    const rank0 = (x: StoredSession) => (x.pinned ? 0 : tab === 'all' && here(x) ? 1 : 2)
    const list = query ? rows() : [...rows()].sort((a, b) => rank0(a) - rank0(b))
    // The label leads the searched text, so a title hit ranks first and its marks land in the label.
    const ranked = rank(list, query, s => `${sessionLabel(s)}\n${s.preview} ${s.cwd} ${s.branch} ${s.id}`, { scattered: false })
    const hits: Record<string, [number, number][]> = {}
    const order: (string | PickerGroup)[] = []

    if (query) {
      order.push({ count: ranked.length, group: 'matches', label: 'Matches' }, ...ranked.map(r => r.item.id))
    } else {
      const groups = new Map<string, string[]>()
      const add = (label: string, id: string) => groups.set(label, [...(groups.get(label) ?? []), id])

      for (const s of list) {
        add(s.pinned ? 'Pinned' : tab === 'all' && here(s) && workspace ? `In ${basename(workspace)}` : dayOf(s.lastActive, now), s.id)
      }

      for (const [label, ids] of groups) {
        order.push({ count: ids.length, group: label, label }, ...ids)
      }
    }

    for (const { item, positions } of ranked) {
      if (positions.length) {
        hits[item.id] = hitRuns(positions, sessionLabel(item).length)
      }
    }

    shown = order.filter((o): o is string => typeof o === 'string')

    if (!selected || !shown.includes(selected)) {
      selected = shown[0]
    }

    // A new selection starts its preview at the top, read once the selection rests.
    if (selected !== told) {
      told = selected
      block = undefined
      focus = 'list'
      loader.select(selected)
    }

    return { hits, order }
  }

  const overlay: Overlay = {
    key: KEY,
    modal: true,
    node: id => {
      nodeId = id
      const now = Date.now()
      const { hits, order } = view(now)
      const s = sessions.find(x => x.id === selected)
      const hereCount = sessions.filter(here).length
      const project = workspace ? basename(workspace) : 'This folder'
      const pane = s
        ? sessionDetail({
            copied: copied.value === s.id,
            focus: key => focusBlock(key),
            focused: focus === 'preview' ? block : undefined,
            isCurrent: s.id === current,
            more: () => loader.more(s.id),
            now,
            preview: loader.get(s.id),
            running: running.has(s.id),
            session: s
          })
        : undefined

      blocks = pane?.blocks ?? []

      return (
        <picker
          actions={[
            { id: 'delete', keys: ['backspace'], label: 'Delete' },
            { ...optional('disabled', s ? undefined : 'No session'), id: 'copy', keys: ['alt+c'], label: 'Copy id' },
            focus === 'preview'
              ? { id: 'list', keys: ['left'], label: 'Back to list' }
              : { ...optional('disabled', s ? undefined : 'No session'), id: 'browse', keys: ['right'], label: 'Browse' },
            { end: true, id: 'close', keys: ['esc'], label: 'Close' },
            { ...optional('disabled', s ? undefined : 'No session'), id: 'resume', keys: ['enter'], label: s?.id === current ? 'Back to it' : 'Resume', primary: true }
          ]}
          columns={[
            { format: 'dim', id: 'size', priority: 1 },
            { format: 'time', id: 'when', priority: 2 }
          ]}
          key={KEY}
          {...optional('confirm', deleting ? { act: 'confirm', label: 'Delete', text: `Delete “${sessionLabel(sessions.find(x => x.id === deleting) ?? { preview: '', title: '' })}”?` } : undefined)}
          current={current ? [current] : []}
          empty={tab === 'here' ? `No sessions in ${project} yet. Tab shows every folder.` : 'No saved sessions yet'}
          focus={focus}
          hits={hits}
          icon="history"
          items={rows().map(x => itemOf(x, now, running.has(x.id), tab === 'all' && !here(x)))}
          layout="cards"
          noun="sessions"
          onAction={{
            browse: () => focusBlock(block ?? blocks[0]),
            cancel: () => {
              deleting = null
              host.changed()
            },
            clear: () => {
              query = ''
              host.changed()
            },
            close: () => host.close(overlay),
            confirm: () => {
              if (deleting) {
                void remove(deleting)
              }
            },
            copy: copyId,
            delete: () => {
              askDelete()
              host.changed()
            },
            list: () => {
              focus = 'list'
              host.changed()
            },
            resume: () => resume(selected),
            retry: () => void load(),
            tab: ev => {
              setTab(ev.value === 'here' ? 'here' : 'all')
              host.changed()
            }
          }}
          onActivate={ev => resume(ev.item)}
          onSelect={ev => {
            selected = ev.item
            deleting = null
            host.changed()
          }}
          order={order}
          placeholder="Search titles, prompts, folders, branches…"
          preview="side"
          query={query}
          role="hermes.sessions"
          {...optional('selected', selected)}
          size="lg"
          state={state}
          subtitle={[{ s: 'muted', t: workspace ? homeTilde(workspace, launchEnv().home) : '' }]}
          tab={tab}
          tabs={[
            { count: hereCount, id: 'here', label: project },
            { count: sessions.length, id: 'all', label: 'All folders' }
          ]}
          title="Sessions"
          total={rows().length}
        >
          {pane?.nodes ?? null}
        </picker>
      )
    },
    onClose: () => {
      loader.dispose()
      copied.dispose()
    },
    onKey: (k: Key) => {
      if (deleting) {
        if (k.name === 'enter' || k.name === 'y') {
          void remove(deleting)
        } else if (k.name === 'escape' || k.name === 'n') {
          deleting = null
        }

        return true
      }

      if (k.name === 'c' && k.alt && !k.ctrl && !k.meta) {
        copyId()
      } else if (k.name === 'enter') {
        resume(selected)
      } else if (k.name === 'tab') {
        setTab(tab === 'here' ? 'all' : 'here')
      } else if (focus === 'preview' && previewKey(k)) {
        // The preview took it.
      } else if (k.name === 'escape') {
        if (query) {
          query = ''
        } else {
          host.close(overlay)
        }
      } else if (k.name === 'right' && !k.ctrl && !k.alt && !k.meta && selected) {
        focusBlock(block ?? blocks[0])
      } else if (k.name === 'backspace' && !query) {
        askDelete()
      } else {
        const moved = moveSelection(k, shown, selected)
        const edited = moved === undefined ? editQuery(k, query) : undefined

        if (moved !== undefined) {
          selected = moved
        } else if (edited !== undefined) {
          query = edited
        }
      }

      return true
    }
  }

  host.open(overlay)
  // After the sheet is up: the read is synchronous.
  setTimeout(() => void load(), 0)
}
