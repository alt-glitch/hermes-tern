// The session picker's list rows: a title, one clean line of what the session was about, its
// branch (and folder, where it ran elsewhere), its size and age; rows grouped by day.

import { basename } from 'node:path'

import type { PickerItem } from '@stencil-hq/tern'

import { optional } from '../../core/assert.js'
import { clip, plural } from '../../core/text.js'
import { sessionLabel, type StoredSession } from '../../hermes/sessionIndex.js'
import { ageShort } from '../../view/format.js'

const DAY = 86_400_000
const SNIPPET = 160

/**
 * `text` as one readable line: no image directives or attachment notes, a code block as `[code]`,
 * no Markdown marks at the line starts, links as their words, whitespace collapsed.
 */
export function snippet(text: string, max = SNIPPET): string {
  const flat = text
    .replace(/```[\s\S]*?(```|$)/g, ' [code] ')
    .replace(/^@image:\S+/gm, '')
    .replace(/\[The user attached [^\]]*\]/g, '')
    .replace(/\[([^\]\n]+)\]\((?:[^)\s]+)\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()

  return clip(flat, { max })
}

/**
 * The row's second line. Under a title it is the first prompt; with no title the label already
 * is the prompt's first sentence, so the line goes on from there.
 */
export function rowDetail(s: Pick<StoredSession, 'preview' | 'title'>): string {
  if (s.title) {
    return snippet(s.preview)
  }

  const label = sessionLabel(s)

  return s.preview.startsWith(label) ? snippet(s.preview.slice(label.length)) : ''
}

/** One list row. `elsewhere`: the session ran outside the pane's project, so its folder shows. */
export function itemOf(s: StoredSession, now: number, running: boolean, elsewhere: boolean): PickerItem {
  const detail = rowDetail(s)

  return {
    badges: [
      ...(running ? [{ text: 'running', tone: 'accent' as const }] : []),
      ...(s.pinned ? [{ text: 'pinned' }] : []),
      ...(s.branch ? [{ text: s.branch, title: `Branch ${s.branch}` }] : []),
      ...(elsewhere && s.cwd ? [{ text: basename(s.cwd), title: s.cwd }] : [])
    ],
    ...optional('detail', detail || undefined),
    facts: { size: plural(s.messages, 'msg'), when: ageShort(now - s.lastActive) },
    id: s.id,
    label: sessionLabel(s),
    ...optional('title', s.cwd || undefined)
  }
}

/** Today / Yesterday / This week / This month / Earlier, by local calendar day. */
export function dayOf(at: number, now: number): string {
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

/** `22 Oct 2026, 09:41`. */
export function dateOf(at: number): string {
  return new Date(at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
}
