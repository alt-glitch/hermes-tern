// `/help`: the keyboard shortcuts, this frontend's own commands, and every
// slash command grouped by the backend's `commands.catalog` categories, in
// omp's hotkeys sheet (`omp.overlay.hotkeys`: sections of key/action tables,
// Close esc).

import type { CommandsCatalogResult } from '@hermes/shared/gateway-events'
import type { Key, SpanData } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import { HIDDEN_COMMANDS, localCommands } from '../commands.js'
import { errorText } from '../core/errors.js'
import type { Overlay } from '../overlay.js'
import { actionsRow } from '../view/ui/button.js'
import { rpc } from '../wire/rpc.js'

/** What the help sheet reaches of the app. */
export type HelpHost = Pick<ChatPorts, 'close' | 'gw' | 'open' | 'session' | 'transcript'>

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
      [['alt+left', 'alt+right', 'alt+f'], 'Move by word'],
      [['ctrl+a', 'ctrl+e'], 'Start / end of line'],
      [['ctrl+w', 'alt+backspace'], 'Delete word backwards'],
      [['ctrl+u'], 'Delete to start of line'],
      [['alt+d'], 'Delete word forward'],
      [['ctrl+k'], 'Delete to end of line (joins the next line at its end)'],
      [['ctrl+y'], 'Paste the last deleted text'],
      [['ctrl+z', 'shift+ctrl+z'], 'Undo / redo'],
      [['cmd+b', 'cmd+i'], 'Bold / italic (Markdown) on the selection or at the caret'],
      [['shift+left', 'shift+right'], 'Select'],
      [['shift+enter'], 'In a list item: the next item (an empty item ends the list)']
    ]
  },
  {
    group: 'Control',
    rows: [
      [['escape'], 'Close the completion'],
      [['escape escape'], 'Clear the draft into the history (Up brings it back) / stop the agent'],
      [['shift+tab'], 'Cycle the reasoning effort (/effort picks one; Ctrl+G there saves it as the default)'],
      [['alt+up'], 'Edit the oldest queued prompt'],
      [['alt+enter'], 'Steer the running turn with the oldest queued prompt (empty prompt)'],
      [['alt+a'], 'Agents'],
      [['alt+j'], 'Background processes and cron jobs (/ps)'],
      [['alt+p'], 'Pull requests Hermes linked (/prs)'],
      [['alt+s'], 'Session sidebar: branch, PRs, changes (/sidebar)'],
      [['ctrl+v'], 'Attach the clipboard image (also ⌘V of an image, a dropped image file, /paste)'],
      [['down'], 'Focus the agents / shells / PR pills (empty prompt); ← → switch, Enter opens, Esc returns'],
      [['ctrl+c'], 'Answer no to the open sheet / clear the draft and images / interrupt / exit (twice)'],
      [['ctrl+d'], 'Delete forward / exit (empty prompt)']
    ]
  }
]

/** Opens the help sheet; the command list comes from the gateway's catalog. */
export async function openHelp(host: HelpHost) {
  let catalog: CommandsCatalogResult = {}
  const sid = host.session.ref.live

  try {
    catalog = await rpc(host.gw, 'commands.catalog', sid ? { session_id: sid } : {})
  } catch (error) {
    host.transcript.notice(
      `Could not load the command list: ${errorText(error)}`,
      'warning'
    )
  }

  const own = localCommands().flatMap(c =>
    c.help ? [[[`/${c.name}`, ...(c.aliases ?? []).map(a => `/${a}`)].join(' · '), c.help]] : []
  )

  // The catalog's hidden rows (/mouse, /pet, /sethome, …) do nothing here.
  const runs = ([command = '']: string[]) => !HIDDEN_COMMANDS.has(command.replace(/^\//, '').split(/\s/)[0] ?? '')

  const categories = [
    { name: 'Tern', pairs: own },
    ...(catalog.categories?.length ? catalog.categories : [{ name: 'Commands', pairs: catalog.pairs ?? [] }])
      .map(c => ({ ...c, pairs: (c.pairs ?? []).filter(runs) }))
      .filter(c => c.pairs.length)
  ]

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
          {actionsRow([{ hint: 'escape', key: 'close', keys: ['escape'], label: 'Close', onClick: () => host.close(overlay) }])}
        </col>
      </overlay>
    ),
    onKey: (k: Key) => {
      if (k.name === 'escape' || k.name === 'enter' || k.name === 'q') {
        host.close(overlay)
      }

      return true
    }
  }

  host.open(overlay)
}
