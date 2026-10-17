// The reasoning effort picker (`/effort`, the effort pill's menu): every level Hermes takes, the
// session's checked, with the model picker's "Save as default" so a pick can become config.yaml's
// `agent.reasoning_effort` for every new session (`config.set reasoning` with `scope: global`).

import type { Key, PickerItem } from '@stencil-hq/tern'

import type { App } from '../app.js'
import type { Overlay } from '../overlay.js'

import { moveSelection } from './search.js'

const KEY = 'effort'

/** Hermes' levels (hermes_constants.VALID_REASONING_EFFORTS, with `none` for off), lowest first. */
export const LEVELS: { id: string; label: string; detail: string }[] = [
  { detail: 'No reasoning tokens', id: 'none', label: 'off' },
  { detail: 'The least thinking a model allows', id: 'minimal', label: 'minimal' },
  { detail: 'Quick answers', id: 'low', label: 'low' },
  { detail: 'The usual balance', id: 'medium', label: 'medium' },
  { detail: 'Harder problems', id: 'high', label: 'high' },
  { detail: 'More than high, where the model has it', id: 'xhigh', label: 'xhigh' },
  { detail: 'Everything the model can spend', id: 'max', label: 'max' }
]

/** Opens the picker on the session's effort; `global` starts with Save as default on. */
export function openEffortPicker(app: App, global = false) {
  const current = app.info?.reasoning_effort ?? ''
  let selected = LEVELS.some(l => l.id === current) ? current : 'medium'
  let saveDefault = global

  const pick = async (id: string | undefined) => {
    if (!id) {
      return
    }

    app.close(overlay)
    await app.setEffort(id, saveDefault ? 'global' : 'session')
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
        current={current ? [current] : []}
        icon="brain"
        items={LEVELS.map(
          (l): PickerItem => ({
            detail: l.detail,
            id: l.id,
            label: l.label
          })
        )}
        key={KEY}
        noun="levels"
        onAction={{
          close: () => app.close(overlay),
          global: () => {
            saveDefault = !saveDefault
            app.changed()
          },
          use: () => void pick(selected)
        }}
        onActivate={ev => void pick(ev.item)}
        onSelect={ev => {
          selected = ev.item
          app.changed()
        }}
        order={LEVELS.map(l => l.id)}
        preview="none"
        selected={selected}
        size="md"
        subtitle={[{ s: 'muted', t: saveDefault ? 'for this session and every new one' : 'for this session' }]}
        title="Reasoning effort"
      />
    ),
    onKey: (k: Key) => {
      if (k.name === 'escape') {
        app.close(overlay)
      } else if (k.name === 'enter') {
        void pick(selected)
      } else if (k.ctrl && k.name === 'g') {
        saveDefault = !saveDefault
      } else {
        selected =
          moveSelection(
            k,
            LEVELS.map(l => l.id),
            selected
          ) ?? selected
      }

      return true
    }
  }

  app.open(overlay)
}
