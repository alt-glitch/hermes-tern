// Session-scoped app shortcuts. Composer and overlay keys keep their own owners.
// Defaults follow the plugin's draft/keys.ts; names follow Hermes ui-tsp/src/actions.ts
// (adapted from Can Bölük / Stencil's OMP shortcuts, MIT).

import type { Key } from '@stencil-hq/tern'

import { KEYS, matches } from '../draft/keys.js'
import { isHoldInfoKey, isVoiceToggleKey } from '../voice/hold.js'

type Modifier = 'ctrl' | 'alt' | 'shift' | 'meta'

export interface Shortcut {
  readonly id: string
  readonly group: string
  readonly title: string
  readonly keys: readonly string[]
  /** Legacy matches retain the plugin's original permissive modifier behavior. */
  readonly legacy?: { readonly must: readonly Modifier[]; readonly forbid: readonly Modifier[] }
}

const legacy = (must: readonly Modifier[], forbid: readonly Modifier[] = []) => ({ must, forbid })

export const APP_SHORTCUTS: readonly Shortcut[] = [
  { id: 'app.agents.hub', group: 'Navigation', title: 'Agents', keys: ['alt+a'], legacy: legacy(['alt'], ['ctrl', 'meta']) },
  { id: 'app.jobs', group: 'Navigation', title: 'Background processes', keys: ['alt+j'], legacy: legacy(['alt'], ['ctrl', 'meta']) },
  { id: 'app.prs', group: 'Navigation', title: 'Linked pull requests', keys: ['alt+p'], legacy: legacy(['alt'], ['ctrl', 'meta', 'shift']) },
  { id: 'app.sidebar', group: 'Navigation', title: 'Session sidebar', keys: ['alt+s'], legacy: legacy(['alt'], ['ctrl', 'meta']) },
  { id: 'app.thinking.cycle', group: 'Control', title: 'Cycle reasoning effort', keys: ['shift+tab'], legacy: legacy(['shift']) },
  { id: 'app.message.dequeue', group: 'Control', title: 'Edit oldest queued prompt', keys: ['alt+up'], legacy: legacy(['alt']) },
  { id: 'app.message.alternate', group: 'Control', title: 'Steer from the queue when busy', keys: ['alt+enter'], legacy: legacy(['alt']) },
  { id: 'app.model.select', group: 'Models', title: 'Select model', keys: ['alt+m'] },
  { id: 'app.model.cycleForward', group: 'Models', title: 'Next recent model', keys: ['ctrl+p'] },
  { id: 'app.model.cycleBackward', group: 'Models', title: 'Previous recent model', keys: ['ctrl+alt+p'] },
  { id: 'app.palette', group: 'Navigation', title: 'Command palette', keys: ['alt+k'] },
  { id: 'app.history.search', group: 'Navigation', title: 'Search prompt history', keys: ['ctrl+r'] },
  { id: 'app.help', group: 'Navigation', title: 'Commands and shortcuts', keys: ['f1', 'alt+/'] }
]

const MODIFIERS: readonly Modifier[] = ['ctrl', 'alt', 'shift', 'meta']
const ALIASES: Readonly<Record<string, string>> = {
  control: 'ctrl', option: 'alt', cmd: 'meta', command: 'meta', super: 'meta',
  esc: 'escape', return: 'enter', arrowup: 'up', arrowdown: 'down',
  arrowleft: 'left', arrowright: 'right', pageup: 'page_up', pagedown: 'page_down'
}

// These are composer's keys, not spare global app bindings. The existing
// Alt+Enter default is intentionally retained but cannot be reassigned.
const EDITOR_KEYS = new Set([
  'enter', 'shift+enter', 'tab', 'up', 'down', 'left', 'right',
  'home', 'end', 'escape', 'backspace', 'delete', 'ctrl+a', 'ctrl+e',
  'ctrl+u', 'ctrl+k', 'ctrl+w', 'ctrl+y', 'ctrl+z', 'ctrl+shift+z',
  'ctrl+v', 'ctrl+c', 'ctrl+d', 'ctrl+g', 'alt+b', 'alt+f', 'alt+d',
  'alt+enter', 'alt+left', 'alt+right', 'alt+backspace'
])

/** Fixed actions and the host's retention key run outside configurable action ownership. */
function fixedChord(chord: string): boolean {
  const parts = chord.split('+')
  const name = parts.pop() ?? ''
  const key: Key = { name, ctrl: parts.includes('ctrl'), alt: parts.includes('alt'), shift: parts.includes('shift'), meta: parts.includes('meta') }
  return [KEYS.browser, KEYS.plan, KEYS.fork, KEYS.copyDraft].some(match => matches(key, match)) ||
    isVoiceToggleKey(key) || isHoldInfoKey(key) || (key.ctrl && name === 'home')
}

/** Composer actions that may otherwise run when a contextual shortcut declines the key. */
function editorChord(chord: string): boolean {
  const parts = chord.split('+')
  const name = parts.pop() ?? ''
  const ctrl = parts.includes('ctrl')
  const alt = parts.includes('alt')
  return EDITOR_KEYS.has(chord) || ['enter', 'escape', 'tab', 'backspace', 'delete', 'left', 'right', 'up', 'down', 'home', 'end'].includes(name) ||
    (ctrl && name === 'z') ||
    (ctrl && !alt && ['a', 'b', 'd', 'e', 'f', 'k', 'u', 'w', 'y', 'backspace', 'delete', 'home', 'end', 'left', 'right'].includes(name)) ||
    (alt && !ctrl && ['b', 'd', 'f'].includes(name))
}

/** Canonical form rejects aliases that would evade collision checks. */
export function normalizeChord(raw: string): string {
  const parts = raw.toLowerCase().split('+').map(s => s.trim()).map(s => ALIASES[s] ?? s)
  const name = parts.pop() ?? ''
  const validName = /^(?:[a-z0-9,./;=\-]|f(?:[1-9]|1[0-9]|2[0-4])|enter|escape|tab|space|backspace|delete|home|end|up|down|left|right|page_up|page_down)$/.test(name)

  if (!validName || parts.some(p => !MODIFIERS.some(m => m === p)) || new Set(parts).size !== parts.length) {
    throw new Error(`Invalid key chord: ${raw}`)
  }

  // Tern 0.9.5 reserves Ctrl+Shift+P (host palette) and Ctrl+Shift+K
  // (clear scrollback); reject unreachable profile overrides.
  if (parts.includes('meta') ||
    (parts.includes('ctrl') && parts.includes('shift') && ['c', 'v', 'k', 'p'].includes(name)) ||
    (parts.includes('alt') && ['f4', 'tab'].includes(name))) {
    throw new Error(`Host-reserved key chord: ${raw}`)
  }

  return [...MODIFIERS.filter(m => parts.includes(m)), name].join('+')
}

function exact(chord: string, key: Key): boolean {
  const parts = chord.split('+')
  const name = parts.pop()

  return key.name.toLowerCase() === name && MODIFIERS.every(m => key[m] === parts.includes(m))
}

/** The selected action's actual matcher, including original legacy shortcuts. */
export function shortcutMatches(shortcut: Shortcut, key: Key): boolean {
  const policy = shortcut.legacy

  if (policy) {
    return shortcut.keys.some(chord => {
      const name = chord.split('+').at(-1)

      return name === key.name.toLowerCase() &&
        policy.must.every(m => key[m]) &&
        policy.forbid.every(m => !key[m])
    })
  }

  return shortcut.keys.some(chord => exact(chord, key))
}

function overlap(a: Shortcut, b: Shortcut): boolean {
  const names = new Set(a.keys.map(k => k.split('+').at(-1)))

  if (!b.keys.some(k => names.has(k.split('+').at(-1)))) {
    return false
  }

  // All possible modifier states, including the original permissive chords.
  for (let mask = 0; mask < 16; mask++) {
    for (const name of names) {
      const key: Key = {
        name: name ?? '',
        ctrl: Boolean(mask & 1),
        alt: Boolean(mask & 2),
        shift: Boolean(mask & 4),
        meta: Boolean(mask & 8)
      }

      if (shortcutMatches(a, key) && shortcutMatches(b, key)) {
        return true
      }
    }
  }

  return false
}

/**
 * Atomically validate one owning profile's overrides. Null resets one action,
 * [] disables it and {} resets all. No fallback to partial configuration.
 */
export function effectiveShortcuts(raw: unknown): readonly Shortcut[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Tern keybindings must be an object keyed by action id.')
  }

  const overrides = new Map<string, readonly string[]>()

  for (const [id, value] of Object.entries(raw)) {
    const action = APP_SHORTCUTS.find(row => row.id === id)

    if (!action) {
      throw new Error(`Unknown Tern action: ${id}`)
    }

    if (value === null) {
      continue
    }

    const keys: unknown[] = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [value]
    const normalized = keys.map(key => {
      if (typeof key !== 'string') {
        throw new Error(`Bindings for ${id} must be strings.`)
      }

      const chord = normalizeChord(key)
      const name = chord.split('+').at(-1) ?? ''
      const mods = chord.split('+').slice(0, -1)
      const printable = name.length === 1 || name === 'space'
      const typing = printable && !mods.includes('ctrl') && (!mods.includes('alt') ||
        id === 'app.message.dequeue' || id === 'app.message.alternate')

      if (fixedChord(chord)) {
        throw new Error(`Fixed app key chord: ${chord}`)
      }

      // Preserve explicit spellings of these two pre-existing defaults.
      const ownDefault = (id === 'app.thinking.cycle' && chord === 'shift+tab') ||
        (id === 'app.message.dequeue' && chord === 'alt+up')
      if ((editorChord(chord) && !ownDefault) || typing) {
        throw new Error(`Composer-owned key chord: ${chord}`)
      }

      return chord
    })

    if (new Set(normalized).size !== normalized.length) {
      throw new Error(`Duplicate chord in ${id}`)
    }

    overrides.set(id, normalized)
  }

  const actions: Shortcut[] = APP_SHORTCUTS.map(action => {
    const keys = overrides.get(action.id)

    // Omit legacy entirely: explicit undefined breaks exact optional properties.
    return keys === undefined ? action : { id: action.id, group: action.group, title: action.title, keys }
  })

  for (let i = 0; i < actions.length; i++) {
    for (let j = i + 1; j < actions.length; j++) {
      const a = actions[i]
      const b = actions[j]

      if (a && b && overlap(a, b)) {
        throw new Error(`Overlapping chord: ${a.id} and ${b.id}`)
      }
    }
  }

  return actions
}

/** App-level only; editor and modal-local shortcuts stay with their owners. */
export function shortcutGroups(actions: readonly Shortcut[] = APP_SHORTCUTS): { group: string; rows: [readonly string[], string][] }[] {
  const groups = new Map<string, [readonly string[], string][]>()

  for (const action of actions) {
    const rows = groups.get(action.group) ?? []
    rows.push([action.keys.length ? action.keys : ['(unbound)'], action.title])
    groups.set(action.group, rows)
  }

  return [...groups].map(([group, rows]) => ({ group, rows }))
}
