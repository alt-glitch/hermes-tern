// The reasoning effort picker (`/effort`, the effort pill's menu): every level the session's model
// takes, the session's checked, with the model picker's "Save as default" so a pick can become
// config.yaml's `agent.reasoning_effort` for every new session (`config.set reasoning` with `scope: global`).

import type { Key, PickerItem } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import { capsOf, loadCaps } from '../modelCaps.js'
import type { Overlay } from '../overlay.js'
import { DEFAULT_EFFORT, levelsFor } from '../session/effort.js'

import { moveSelection } from './search.js'

const KEY = 'effort'

/** What the effort picker reaches of the app. */
export type EffortHost = Pick<ChatPorts, 'changed' | 'close' | 'gw' | 'open' | 'session' | 'setEffort'>

/** Opens the picker on the session's effort; `global` starts with Save as default on. */
export function openEffortPicker(host: EffortHost, global = false) {
  const current = host.session.info?.reasoning_effort || DEFAULT_EFFORT
  let levels = levelsFor(capsOf(host.session.info))
  let selected = levels.some(l => l.id === current) ? current : DEFAULT_EFFORT
  let saveDefault = global

  // The first open may not know the model yet: its capabilities narrow the list when they arrive.
  if (!capsOf(host.session.info)) {
    void loadCaps(host.gw, host.session.ref.live).then(() => {
      levels = levelsFor(capsOf(host.session.info))
      selected = levels.some(l => l.id === selected) ? selected : (levels[0]?.id ?? selected)
      host.changed()
    })
  }

  const pick = async (id: string | undefined) => {
    if (!id || !levels.some(l => l.id === id)) {
      return
    }

    host.close(overlay)
    await host.setEffort(id, saveDefault ? 'global' : 'session')
  }

  const overlay: Overlay = {
    key: KEY,
    modal: true,
    node: () => (
      <picker
        actions={[
          { id: 'global', keys: ['ctrl+g'], label: 'Save as default', on: saveDefault },
          { end: true, id: 'close', keys: ['esc'], label: 'Close' },
          { id: 'use', keys: ['enter'], label: saveDefault ? 'Set and save' : 'Set', primary: true }
        ]}
        current={[current]}
        empty="This model has no reasoning effort to set"
        icon="brain"
        items={levels.map(
          (l): PickerItem => ({
            detail: l.detail,
            id: l.id,
            label: l.label
          })
        )}
        key={KEY}
        noun="levels"
        onAction={{
          close: () => host.close(overlay),
          global: () => {
            saveDefault = !saveDefault
            host.changed()
          },
          use: () => void pick(selected)
        }}
        onActivate={ev => void pick(ev.item)}
        onSelect={ev => {
          selected = ev.item
          host.changed()
        }}
        order={levels.map(l => l.id)}
        preview="none"
        selected={selected}
        size="md"
        subtitle={[
          {
            s: 'muted',
            t: `${saveDefault ? 'for this session and every new one' : 'for this session'}${host.session.info?.reasoning_effort ? '' : ` · ${DEFAULT_EFFORT} is the default`}`
          }
        ]}
        title="Reasoning effort"
      />
    ),
    onKey: (k: Key) => {
      if (k.name === 'escape') {
        host.close(overlay)
      } else if (k.name === 'enter') {
        void pick(selected)
      } else if (k.ctrl && k.name === 'g') {
        saveDefault = !saveDefault
      } else {
        selected =
          moveSelection(
            k,
            levels.map(l => l.id),
            selected
          ) ?? selected
      }

      return true
    }
  }

  host.open(overlay)
}
