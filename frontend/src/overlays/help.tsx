// `/help`: the keyboard shortcuts and every slash command, grouped by the
// backend's `commands.catalog` categories, in omp's hotkeys sheet
// (`omp.overlay.hotkeys`: sections of key/action tables, Close esc).

import type { CommandsCatalogResult } from '@hermes/shared/gateway-events'
import type { Key, SpanData } from '@stencil-hq/tern'

import type { App } from '../app.js'
import type { Overlay } from '../overlay.js'

const KEY = 'help'

/** The shortcuts this frontend handles (composer.ts, app.ts), by group. */
const HOTKEYS: { group: string; rows: [string[], string][] }[] = [
  {
    group: 'Editing',
    rows: [
      [['enter'], 'Send message'],
      [['shift+enter', 'alt+enter'], 'New line'],
      [['up', 'down'], 'Move between lines / browse history'],
      [['tab'], 'Accept the completion'],
      [['alt+left', 'alt+right', 'alt+b', 'alt+f'], 'Move by word'],
      [['ctrl+a', 'ctrl+e'], 'Start / end of line'],
      [['ctrl+w', 'alt+backspace'], 'Delete word backwards'],
      [['ctrl+u'], 'Delete to start of line'],
      [['alt+d'], 'Delete word forward'],
      [['ctrl+k'], 'Delete to end of line (joins the next line at its end)'],
      [['ctrl+y'], 'Paste the last deleted text'],
      [['ctrl+z', 'shift+ctrl+z'], 'Undo / redo']
    ]
  },
  {
    group: 'Control',
    rows: [
      [['escape'], 'Close the completion / interrupt the agent'],
      [['shift+tab'], 'Cycle the reasoning effort'],
      [['alt+up'], 'Edit the oldest queued prompt'],
      [['ctrl+c'], 'Clear the draft / interrupt / exit (twice)'],
      [['ctrl+d'], 'Delete forward / exit (empty prompt)']
    ]
  }
]

/** Opens the help sheet; the command list comes from the gateway's catalog. */
export async function openHelp(app: App) {
  let catalog: CommandsCatalogResult = {}

  try {
    catalog = await app.gw.request<CommandsCatalogResult>('commands.catalog', app.sid ? { session_id: app.sid } : {})
  } catch (error) {
    app.transcript.notice(
      `Could not load the command list: ${error instanceof Error ? error.message : String(error)}`,
      'warning'
    )
  }

  const categories = catalog.categories?.length
    ? catalog.categories
    : [{ name: 'Commands', pairs: catalog.pairs ?? [] }]

  const overlay: Overlay = {
    key: KEY,
    modal: true,
    node: () => (
      <overlay anchor="center" head="Commands and shortcuts" key={KEY} modal role="omp.overlay.hotkeys" size="lg">
        <col gap="lg" key="body">
          {HOTKEYS.map(({ group, rows }) => (
            <section head={group} key={`keys-${group}`} role="omp.hotkeys.group">
              <table
                cols={[
                  { head: 'Key', id: 'keys' },
                  { grow: 1, head: 'Action', id: 'action' }
                ]}
                key="table"
                role="omp.hotkeys.table"
                rows={rows.map(([keys, action], i) => ({
                  cells: {
                    action: [{ t: action }],
                    keys: keys.flatMap((k, j): SpanData[] => [...(j ? [{ s: 'dim', t: ' ' }] : []), { s: 'key', t: k }])
                  },
                  id: String(i)
                }))}
              />
            </section>
          ))}
          {categories.map(c => (
            <section head={c.name} key={`cmd-${c.name}`} role="omp.hotkeys.group">
              <table
                cols={[
                  { head: 'Command', id: 'command' },
                  { grow: 1, head: 'Description', id: 'action' }
                ]}
                key="table"
                role="omp.hotkeys.table"
                rows={(c.pairs ?? []).map(([command = '', text = ''], i) => ({
                  // The `(usage: …)` tail is `/help <command>`'s business; the table keeps the summary.
                  cells: {
                    action: [{ t: text.replace(/\s*\(usage: .+\)\s*$/, '') }],
                    command: [{ s: 'mono', t: command }]
                  },
                  id: String(i)
                }))}
              />
            </section>
          ))}
          <row align="center" gap="sm" key="actions" role="omp.actions">
            <spacer grow={1} key="fill" />
            <row
              align="center"
              gap="xs"
              key="close"
              onClick={() => app.close(overlay)}
              role="omp.btn"
              title="Close  escape"
            >
              <text key="label" text="Close" />
              <kbd key="keys" keys={['escape']} />
            </row>
          </row>
        </col>
      </overlay>
    ),
    onKey: (k: Key) => {
      if (k.name === 'escape' || k.name === 'enter' || k.name === 'q') {
        app.close(overlay)
      }

      return true
    }
  }

  app.open(overlay)
}
