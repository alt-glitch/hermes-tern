// The session picker (`/resume`, `/sessions`): stored conversations from the profile's state.db
// (hermes/sessionIndex.ts), scoped the way `hermes -c` scopes them. The first tab holds this
// project's sessions (the pane's repo, or its folder); All holds every local one with this
// project's first. Rows are grouped by last activity, pinned ones on top; a search ranks title,
// first prompt, folder, branch and id across the tab. The preview shows where the session ran,
// its first prompt and its last reply. Enter resumes; Tab switches the scope; ⌫ on an empty
// search deletes after a confirm.

import { basename } from 'node:path'

import type { JSX, Key, PickerGroup, PickerItem, Span } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import { launchEnv } from '../config/env.js'
import { errorText } from '../core/errors.js'
import { durable, storedSessionId } from '../core/ids.js'
import { mutateSession } from '../hermes/mutate.js'
import { inWorkspace, lastReply, sessionLabel, type StoredSession, storedSessions, workspaceOf } from '../hermes/sessionIndex.js'
import type { Overlay } from '../overlay.js'
import { oneLine } from '../view/describe.js'
import { rpc } from '../wire/rpc.js'

import { editQuery, hitRuns, moveSelection, rank } from './search.js'

/** What the session picker reaches of the app. */
export type SessionsHost = Pick<ChatPorts, 'changed' | 'close' | 'gw' | 'open' | 'resume' | 'session' | 'transcript'>

const KEY = 'sessions'
const LIMIT = 400
const DAY = 86_400_000

type Tab = 'all' | 'here'

/** Opens the session picker; picking a row resumes that session. */
export function openSessionPicker(host: SessionsHost) {
  let state: 'loading' | 'ready' | 'error' = 'loading'
  let sessions: StoredSession[] = []
  let running = new Set<string>()
  let workspace = ''
  let tab: Tab = 'here'
  let query = ''
  let selected: string | undefined
  let deleting: string | null = null
  let shown: string[] = []
  const replies = new Map<string, string>()
  const current = durable(host.session.ref) ?? ''

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

  const setTab = (t: Tab) => {
    tab = t
    deleting = null
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

    return { hits, order }
  }

  const overlay: Overlay = {
    key: KEY,
    modal: true,
    node: () => {
      const now = Date.now()
      const { hits, order } = view(now)
      const s = sessions.find(x => x.id === selected)
      const hereCount = sessions.filter(here).length
      const project = workspace ? basename(workspace) : 'This folder'

      if (s && !replies.has(s.id)) {
        replies.set(s.id, lastReply(s.id))
      }

      return (
        <picker
          actions={[
            { id: 'delete', keys: ['backspace'], label: 'Delete' },
            { end: true, id: 'close', keys: ['esc'], label: 'Close' },
            { disabled: s ? undefined : 'No session', id: 'resume', keys: ['enter'], label: s?.id === current ? 'Back to it' : 'Resume', primary: true }
          ]}
          columns={[
            { format: 'dim', id: 'size', priority: 1 },
            { format: 'time', id: 'when', priority: 2 }
          ]}
          confirm={deleting ? { act: 'confirm', label: 'Delete', text: `Delete “${sessionLabel(sessions.find(x => x.id === deleting) ?? { preview: '', title: '' })}”?` } : undefined}
          current={current ? [current] : []}
          empty={tab === 'here' ? `No sessions in ${project} yet. Tab shows every folder.` : 'No saved sessions yet'}
          hits={hits}
          icon="history"
          items={rows().map(x => itemOf(x, now, running.has(x.id), tab === 'all' && !here(x)))}
          key={KEY}
          layout="cards"
          noun="sessions"
          onAction={{
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
            delete: () => {
              askDelete()
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
          selected={selected}
          size="lg"
          state={state}
          subtitle={[{ s: 'muted', t: workspace ? shortPath(workspace) : '' }]}
          tab={tab}
          tabs={[
            { count: hereCount, id: 'here', label: project },
            { count: sessions.length, id: 'all', label: 'All folders' }
          ]}
          title="Sessions"
          total={rows().length}
        >
          {s ? preview(s, now, s.id === current, running.has(s.id), replies.get(s.id) ?? '') : null}
        </picker>
      )
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

      if (k.name === 'escape') {
        if (query) {
          query = ''
        } else {
          host.close(overlay)
        }
      } else if (k.name === 'enter') {
        resume(selected)
      } else if (k.name === 'tab') {
        setTab(tab === 'here' ? 'all' : 'here')
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

function itemOf(s: StoredSession, now: number, running: boolean, elsewhere: boolean): PickerItem {
  const label = sessionLabel(s)

  return {
    badges: [
      ...(running ? [{ text: 'running', tone: 'accent' as const }] : []),
      ...(s.branch ? [{ text: s.branch, title: `Branch ${s.branch}` }] : []),
      ...(elsewhere && s.cwd ? [{ text: basename(s.cwd), title: s.cwd }] : [])
    ],
    detail: s.title && s.preview ? oneLine(s.preview) : undefined,
    facts: { size: `${s.messages} msg${s.messages === 1 ? '' : 's'}`, when: ageOf(s.lastActive, now) },
    id: s.id,
    label,
    title: s.cwd || undefined
  }
}

function preview(s: StoredSession, now: number, isCurrent: boolean, running: boolean, reply: string): JSX.Element[] {
  const status: Span[] | undefined = isCurrent
    ? [{ s: 'success', t: 'open here' }]
    : running
      ? [{ s: 'accent', t: 'running in another pane' }]
      : undefined

  return [
    <text key="title" role="omp.picker.title" text={sessionLabel(s)} />,
    <kv
      items={[
        ...(status ? [{ k: [{ t: 'Status' }], v: status }] : []),
        ...(s.cwd ? [{ k: [{ t: 'Folder' }], v: [{ s: 'mono', t: shortPath(s.cwd) }] as Span[] }] : []),
        ...(s.branch ? [{ k: [{ t: 'Branch' }], v: [{ s: 'mono', t: s.branch }] as Span[] }] : []),
        { k: [{ t: 'Last active' }], v: `${dateOf(s.lastActive)} · ${ageOf(s.lastActive, now)} ago` },
        { k: [{ t: 'Started' }], v: dateOf(s.startedAt) },
        { k: [{ t: 'Messages' }], v: String(s.messages) },
        ...(s.model ? [{ k: [{ t: 'Model' }], v: [{ s: 'mono', t: s.model }] as Span[] }] : []),
        { k: [{ t: 'Session' }], v: [{ s: 'mono dim', t: `${s.source} · ${s.id.replace(/^(local-)?(.{12}).*$/, '$1$2…')}` }] }
      ]}
      key="facts"
    />,
    ...(s.preview
      ? [
          <section head="First prompt" key="first">
            <md key="text" max={{ h: '8lines' }} text={s.preview} tone="user" />
          </section>
        ]
      : []),
    ...(reply
      ? [
          <section head="Last reply" key="last">
            <md key="text" max={{ h: '14lines' }} text={reply.slice(0, 2000)} />
          </section>
        ]
      : [])
  ]
}

function shortPath(path: string): string {
  const home = launchEnv().home

  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

/** `25m`, `2h`, `3d`, `1w`, `2mo`, `1y`: how long ago, as omp's session list writes it. */
function ageOf(at: number, now: number): string {
  const m = Math.max(0, Math.round((now - at) / 60_000))

  if (m < 60) {
    return `${Math.max(1, m)}m`
  }

  const h = Math.round(m / 60)

  if (h < 24) {
    return `${h}h`
  }

  const d = Math.round(h / 24)

  return d < 7 ? `${d}d` : d < 30 ? `${Math.round(d / 7)}w` : d < 365 ? `${Math.round(d / 30)}mo` : `${Math.round(d / 365)}y`
}

/** Today / Yesterday / This week / This month / Earlier, by local calendar day. */
function dayOf(at: number, now: number): string {
  const midnight = new Date(now).setHours(0, 0, 0, 0)

  return at >= midnight
    ? 'Today'
    : at >= midnight - DAY
      ? 'Yesterday'
      : at >= midnight - 6 * DAY
        ? 'This week'
        : at >= midnight - 30 * DAY
          ? 'This month'
          : 'Earlier'
}

function dateOf(at: number): string {
  return new Date(at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
}
