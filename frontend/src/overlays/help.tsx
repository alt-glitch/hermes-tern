// `/help`: the keyboard shortcuts, this frontend's own commands, and every
// slash command grouped by the backend's `commands.catalog` categories, in
// omp's hotkeys sheet (`omp.overlay.hotkeys`: sections of key/action tables,
// Close esc).

import type { CommandsCatalogResult } from '@hermes/shared/gateway-events'
import type { Key, SpanData } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import { HIDDEN_COMMANDS, localCommands } from '../commands/local.js'
import { errorText } from '../core/errors.js'
import { KEYS } from '../draft/keys.js'
import { APP_SHORTCUTS, shortcutGroups, type Shortcut } from '../shortcuts/actions.js'
import { actionsRow } from '../view/ui/button.js'
import { rpc } from '../wire/rpc.js'

import { nativeOverlayKey } from './identity.js'
import type { Overlay } from './overlay.js'

/** What the help sheet reaches of the app. */
export type HelpHost = Pick<ChatPorts, 'close' | 'gw' | 'open' | 'session' | 'transcript'>

const KEY = 'help'

/** Immutable editing and safety controls only; profile-owned actions are projected separately. */
export const HOTKEYS: readonly { group: string; rows: [string[], string][] }[] = [
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
      [[KEYS.clearOrStop.label], 'Clear the draft into the history (Up brings it back) / stop the agent'],
      [[KEYS.browser.label], 'Tern browser blocks: inspect, hand over, focus, release, select frame'],
      [[KEYS.plan.label], 'Review latest plan (/plan; /plan <task> generates via Hermes)'],
      [[KEYS.fork.label], 'Fork this session into a new Tern pane (/fork [durable-message-id])'],
      [[KEYS.clipboardImage.label], 'Attach the clipboard image (also ⌘V of an image, a dropped image file, /paste)'],
      [['alt+v'], 'After /voice on: dictate into the composer, then end the capture (voice.record_key picks another key; esc cancels)'],
      [[KEYS.copyDraft.label, 'alt+shift+c'], 'Copy draft / current line (OSC 52; no submission)'],
      [['down'], 'Focus the agents / shells / PR pills (empty prompt); ← → switch, Enter opens, Esc returns'],
      [[KEYS.cancel.label], 'Answer no to the open sheet / clear the draft and images / interrupt / exit (twice)'],
      [[KEYS.quit.label], 'Delete forward / exit (empty prompt)']
    ]
  }
]

/** Opens the help sheet; the command list comes from the gateway's catalog. */
export async function openHelp(host: HelpHost, actions: readonly Shortcut[] = APP_SHORTCUTS) {
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

  // Merge semantic headings: the SDK rejects duplicate sibling keys
  // (keys-Control). Static rows never copy configurable profile actions.
  const sections = new Map<string, [string[], string][]>()

  for (const section of [...HOTKEYS, ...shortcutGroups(actions)]) {
    const rows = sections.get(section.group) ?? []

    for (const [keys, title] of section.rows) {
      if (!rows.some(([prior, label]) => label === title && prior.join(' ') === keys.join(' '))) {
        rows.push([[...keys], title])
      }
    }

    sections.set(section.group, rows)
  }

  // Catalog categories may repeat or reuse the Tern heading; coalesce by
  // semantic heading and command name in first-seen order before rendering.
  const commandGroups = new Map<string, string[][]>()

  for (const category of categories) {
    const rows = commandGroups.get(category.name) ?? []

    for (const pair of category.pairs) {
      if (!rows.some(([command]) => command === pair[0])) {
        rows.push([...pair])
      }
    }

    commandGroups.set(category.name, rows)
  }

  const overlay: Overlay = {
    key: KEY,
    modal: true,
    node: id => (
      <overlay anchor="center" head="Commands and shortcuts" key={nativeOverlayKey(id)} modal role="omp.overlay.hotkeys" size="lg">
        <col gap="lg" key="body">
          {[...sections].map(([group, rows]) => (
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
          {[...commandGroups].map(([name, pairs]) => (
            <section head={name} key={`cmd-${name}`} role="omp.hotkeys.group">
              <table
                cols={[
                  { head: 'Command', id: 'command' },
                  { grow: 1, head: 'Description', id: 'action' }
                ]}
                key="table"
                role="omp.hotkeys.table"
                rows={pairs.map(([command = '', text = ''], i) => ({
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
