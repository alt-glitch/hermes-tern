// Ctrl+R searches the current profile's readline prompt history, without sending.
// It reads the same history as the composer's Up/Down keys and never edits the draft
// until the user explicitly picks an entry.
import type { Key, PickerItem } from '@stencil-hq/tern'

import type { Composer } from '../draft/composer.js'
import { load as loadHistory } from '../hermes/history.js'

import { nativeOverlayKey } from './identity.js'
import type { Overlay, OverlayHost } from './overlay.js'
import { editQuery, hitRuns, moveSelection, rank } from './search.js'

interface HistoryRow {
  readonly id: string
  readonly text: string
  readonly search: string
  readonly label: string
}

/** Open the native fuzzy picker over the same owning-profile history used by Up/Down. */
export function openPromptHistorySearch(
  host: OverlayHost,
  composer: Pick<Composer, 'set'>,
  history: readonly string[] = loadHistory()
): void {
  // The history source is oldest first; show the newest prompt first.
  const rows: HistoryRow[] = history
    .map((text, index) => {
      const search = text.replace(/\s+/g, ' ').trim()

      return { id: String(index), text, search, label: search.length > 140 ? search.slice(0, 140) + '…' : search }
    })
    .filter(row => row.search.length > 0)
    .reverse()
  let query = ''
  let shown = rows.map(row => row.id)
  let selected = shown[0]
  let alive = true

  const refresh = () => {
    const matches = rank(rows, query, row => row.search)

    shown = matches.map(match => match.item.id)
    if (selected === undefined || !shown.includes(selected)) {
      selected = shown[0]
    }

    return matches
  }

  const fill = (id = selected) => {
    if (!alive || id === undefined || !shown.includes(id)) return
    const picked = rows.find(row => row.id === id)

    if (!picked) return
    host.close(overlay)
    // A recalled prompt is untrusted text, as with Up/Down; never interpret {!cmd}.
    composer.set(picked.text, { literal: true })
    host.changed()
  }

  const overlay: Overlay = {
    key: 'prompt-history-search',
    modal: true,
    onClose: () => { alive = false },
    node: root => {
      const matches = refresh()
      const hits: Record<string, [number, number][]> = {}
      const items: PickerItem[] = rows.map(row => ({ id: row.id, label: row.label, mono: true }))

      for (const { item, positions } of matches) {
        if (positions.length) hits[item.id] = hitRuns(positions, item.label.length)
      }

      return (
        <picker
          actions={[
            { end: true, id: 'close', keys: ['esc'], label: 'Cancel' },
            { id: 'fill', keys: ['enter'], label: 'Fill draft', primary: true }
          ]}
          empty={query ? 'No matching prompts' : 'No saved prompts yet'}
          hits={hits}
          icon="history"
          items={items}
          key={nativeOverlayKey(root)}
          noun="prompts"
          onAction={{
            clear: () => { query = ''; refresh(); host.changed() },
            close: () => host.close(overlay),
            fill: () => fill()
          }}
          onActivate={ev => fill(ev.item)}
          onSelect={ev => {
            if (shown.includes(ev.item)) selected = ev.item
            host.changed()
          }}
          order={[...shown]}
          placeholder="Search previous prompts…"
          query={query}
          role="omp.overlay.history"
          {...(selected === undefined ? {} : { selected })}
          size="lg"
          state="ready"
          title="Prompt history"
          total={rows.length}
        />
      )
    },
    onKey: (key: Key) => {
      if (key.name === 'escape') {
        host.close(overlay)
      } else if (key.name === 'enter') {
        fill()
      } else {
        const moved = moveSelection(key, shown, selected)

        if (moved !== undefined) {
          selected = moved
        } else {
          const edited = editQuery(key, query)

          if (edited !== undefined) {
            query = edited
            refresh()
          }
        }
      }

      return true
    }
  }

  host.open(overlay)
}
