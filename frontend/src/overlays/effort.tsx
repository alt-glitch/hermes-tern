// The reasoning effort picker (`/effort`, the effort pill's menu): every level the session's model
// takes, the session's checked, with the model picker's "Save as default" so a pick can become
// config.yaml's `agent.reasoning_effort` for every new session (`config.set reasoning` with `scope: global`).

import type { ModelCapabilities } from '@hermes/shared/gateway-events'
import type { Key, PickerItem } from '@stencil-hq/tern'

import type { App } from '../app.js'
import { capsOf, loadCaps } from '../modelCaps.js'
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
  { detail: 'Everything the model can spend', id: 'max', label: 'max' },
  { detail: 'Past max where the route has it; elsewhere it sends max', id: 'ultra', label: 'ultra' }
]

/** The level a session runs at when none is set (hermes' DEFAULT_REASONING_EFFORT). */
export const DEFAULT_EFFORT = 'medium'

/** What Shift+Tab and the effort chip step through, lowest first (`none` turns reasoning off). */
const CYCLE = ['none', 'low', 'medium', 'high', 'xhigh']

/** The levels a model takes: none without reasoning, no `off` where it cannot be turned off; all when unknown. */
export function levelsFor(caps: ModelCapabilities | undefined): typeof LEVELS {
  if (caps?.reasoning === false) {
    return []
  }

  return caps?.can_disable_reasoning === false ? LEVELS.filter(l => l.id !== 'none') : LEVELS
}

/** The cycle's next level after `current` ('' is the default); from a level off the cycle, the next one up. */
export function nextEffort(current: string, caps?: ModelCapabilities): string | undefined {
  const offered = new Set(levelsFor(caps).map(l => l.id))
  const cycle = CYCLE.filter(id => offered.has(id))
  const rank = (id: string) => LEVELS.findIndex(l => l.id === id)
  const at = rank(current || DEFAULT_EFFORT)

  return cycle.find(id => rank(id) > at) ?? cycle[0]
}

/** The chip's words: `off`, `high`, a clamped `ultra→max` (what the route really sends). */
export function effortText(effort: string, wire?: string): string {
  const shown = effort === 'none' ? 'off' : effort || DEFAULT_EFFORT

  return wire && effort && wire !== effort && effort !== 'none' ? `${shown}→${wire}` : shown
}

/** Opens the picker on the session's effort; `global` starts with Save as default on. */
export function openEffortPicker(app: App, global = false) {
  const current = app.info?.reasoning_effort || DEFAULT_EFFORT
  let levels = levelsFor(capsOf(app.info))
  let selected = levels.some(l => l.id === current) ? current : DEFAULT_EFFORT
  let saveDefault = global

  // The first open may not know the model yet: its capabilities narrow the list when they arrive.
  if (!capsOf(app.info)) {
    void loadCaps(app.gw, app.sid).then(() => {
      levels = levelsFor(capsOf(app.info))
      selected = levels.some(l => l.id === selected) ? selected : (levels[0]?.id ?? selected)
      app.changed()
    })
  }

  const pick = async (id: string | undefined) => {
    if (!id || !levels.some(l => l.id === id)) {
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
        order={levels.map(l => l.id)}
        preview="none"
        selected={selected}
        size="md"
        subtitle={[
          {
            s: 'muted',
            t: `${saveDefault ? 'for this session and every new one' : 'for this session'}${app.info?.reasoning_effort ? '' : ` · ${DEFAULT_EFFORT} is the default`}`
          }
        ]}
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
            levels.map(l => l.id),
            selected
          ) ?? selected
      }

      return true
    }
  }

  app.open(overlay)
}
