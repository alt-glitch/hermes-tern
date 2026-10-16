// The session picker (`/resume`, `/sessions`): stored sessions as omp's
// session sheet draws them (two-line cards grouped by day, ages, message
// counts, the selected one's preview). Enter resumes it in place of the
// current transcript; ⌫ on an empty search deletes it after a confirm.

import type { SessionListResult, SessionListRow } from '@hermes/shared/gateway-events'
import type { JSX, Key, PickerGroup, PickerItem } from '@stencil-hq/tern'

import type { App } from '../app.js'
import type { Overlay } from '../overlay.js'

import { editQuery, hitRuns, moveSelection, rank } from './search.js'

const KEY = 'sessions'
const LIMIT = 200
const DAY = 86_400_000

/** Opens the session picker; picking a row resumes that session. */
export function openSessionPicker(app: App) {
  let state: 'loading' | 'ready' | 'error' = 'loading'
  let message = ''
  let rows: SessionListRow[] = []
  let query = ''
  let selected: string | undefined
  let deleting: string | null = null
  let shown: string[] = []

  const load = async () => {
    state = 'loading'
    app.changed()

    try {
      const r = await app.gw.request<SessionListResult>('session.list', { limit: LIMIT })
      rows = [...(r.sessions ?? [])].sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))
      selected = rows.find(r => r.id !== app.storedSid)?.id ?? rows[0]?.id
      state = 'ready'
    } catch (error) {
      state = 'error'
      message = error instanceof Error ? error.message : String(error)
    }

    app.changed()
  }

  const resume = (id: string | undefined) => {
    const row = rows.find(r => r.id === id)

    if (!row) {
      return
    }

    app.close(overlay)

    if (row.id !== app.storedSid) {
      void app.resume(row.resolved_id || row.id)
    }
  }

  const remove = async (id: string) => {
    deleting = null

    try {
      await app.gw.request('session.delete', { session_id: id })
      rows = rows.filter(r => r.id !== id)
    } catch (error) {
      app.transcript.notice(error instanceof Error ? error.message : String(error), 'error')
    }

    app.changed()
  }

  const askDelete = () => {
    if (!selected) {
      return
    }

    if (selected === app.storedSid) {
      app.transcript.notice('The open session cannot be deleted; start a new one first.', 'warning')
    } else {
      deleting = selected
    }
  }

  const view = (now: number) => {
    const ranked = rank(rows, query, r => `${labelOf(r)} ${r.preview ?? ''}`)
    const hits: Record<string, [number, number][]> = {}
    const buckets = new Map<string, { label: string; ids: string[] }>()

    for (const { item, positions } of ranked) {
      const label = query ? 'Matches' : dayOf(item.started_at, now)
      const bucket = buckets.get(label) ?? { ids: [], label }
      bucket.ids.push(item.id)
      buckets.set(label, bucket)

      if (positions.length) {
        hits[item.id] = hitRuns(positions, labelOf(item).length)
      }
    }

    const order: (string | PickerGroup)[] = []

    for (const { ids, label } of buckets.values()) {
      order.push({ count: ids.length, group: label, label }, ...ids)
    }

    shown = ranked.map(r => r.item.id)

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
      const row = rows.find(r => r.id === selected)

      return (
        <picker
          actions={[
            { id: 'resume', keys: ['enter'], label: 'Resume', primary: true },
            { id: 'delete', keys: ['backspace'], label: 'Delete' },
            { end: true, id: 'close', keys: ['esc'], label: 'Close' }
          ]}
          columns={[
            { format: 'time', id: 'when' },
            { format: 'dim', id: 'size' }
          ]}
          confirm={
            deleting
              ? { act: 'confirm', label: 'Delete', text: `Delete “${labelOf(rows.find(r => r.id === deleting))}”?` }
              : undefined
          }
          current={app.storedSid ? [app.storedSid] : []}
          empty="No saved sessions yet"
          hits={hits}
          icon="history"
          items={rows.map(r => itemOf(r, now))}
          key={KEY}
          layout="cards"
          message={state === 'error' ? message : undefined}
          noun="sessions"
          onAction={{
            cancel: () => {
              deleting = null
              app.changed()
            },
            clear: () => {
              query = ''
              app.changed()
            },
            close: () => app.close(overlay),
            confirm: () => {
              if (deleting) {
                void remove(deleting)
              }
            },
            delete: () => {
              askDelete()
              app.changed()
            },
            resume: () => resume(selected),
            retry: () => void load()
          }}
          onActivate={ev => resume(ev.item)}
          onSelect={ev => {
            selected = ev.item
            deleting = null
            app.changed()
          }}
          order={order}
          placeholder="Search sessions…"
          preview="side"
          query={query}
          selected={selected}
          size="lg"
          state={state}
          total={rows.length}
        >
          {row ? preview(row, row.id === app.storedSid) : null}
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
        app.close(overlay)
      } else if (k.name === 'enter') {
        resume(selected)
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

  app.open(overlay)
  void load()
}

/** A session's title, else its first prompt. */
function labelOf(row: SessionListRow | undefined): string {
  return row?.title?.trim() || row?.preview?.trim() || 'Untitled session'
}

function itemOf(row: SessionListRow, now: number): PickerItem {
  const count = row.live_message_count ?? row.message_count ?? 0

  return {
    badges: row.source && row.source !== 'tui' && row.source !== 'cli' ? [{ text: row.source }] : undefined,
    detail: row.title?.trim() && row.preview?.trim() ? row.preview.trim() : undefined,
    facts: {
      size: `${count} msg${count === 1 ? '' : 's'}`,
      when: row.started_at ? ageOf(row.started_at * 1000, now) : ''
    },
    id: row.id,
    label: labelOf(row),
    title: row.started_at ? dateOf(row.started_at) : undefined
  }
}

function preview(row: SessionListRow, isCurrent: boolean): JSX.Element[] {
  const count = row.live_message_count ?? row.message_count ?? 0

  return [
    <text key="title" role="omp.picker.title" text={labelOf(row)} />,
    <kv
      items={[
        ...(row.started_at ? [{ k: [{ t: 'Started' }], v: dateOf(row.started_at) }] : []),
        { k: [{ t: 'Messages' }], v: String(count) },
        ...(row.source ? [{ k: [{ t: 'Source' }], v: row.source }] : []),
        ...(isCurrent ? [{ k: [{ t: 'Status' }], v: [{ s: 'success', t: 'open' }] }] : []),
        { k: [{ t: 'ID' }], v: [{ s: 'mono dim', t: row.id }] }
      ]}
      key="facts"
    />,
    ...(row.preview?.trim()
      ? [
          <section head="Conversation" key="conversation">
            <md key="first" text={row.preview.trim()} tone="user" />
          </section>
        ]
      : [])
  ]
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

  return d < 7
    ? `${d}d`
    : d < 30
      ? `${Math.round(d / 7)}w`
      : d < 365
        ? `${Math.round(d / 30)}mo`
        : `${Math.round(d / 365)}y`
}

/** Today / Yesterday / This week / Earlier, by local calendar day. */
function dayOf(startedAt: number | undefined, now: number): string {
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const at = (startedAt ?? 0) * 1000

  return at >= midnight
    ? 'Today'
    : at >= midnight - DAY
      ? 'Yesterday'
      : at >= midnight - 6 * DAY
        ? 'This week'
        : 'Earlier'
}

function dateOf(startedAt: number): string {
  return new Date(startedAt * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
}
