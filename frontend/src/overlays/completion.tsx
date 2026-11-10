// Completions for the composer: slash commands, inline `/skill` references and
// `@`/path words, fetched from the gateway as the text before the caret
// changes and shown as a list above the composer (`omp.autocomplete`).
// Tab accepts; Enter accepts a row that changes the token, else submits.

import type { CompleteSlashResult, CompletionItem } from '@hermes/shared/gateway-events'
import type { JSX, Key } from '@stencil-hq/tern'
import type { GatewayClient } from '@hermes/shared/gateway-client'

import { HIDDEN_COMMANDS, localCommands } from '../commands/local.js'
import { optional } from '../core/assert.js'
import type { Composer } from '../draft/composer.js'
import { boundaryAt } from '../draft/keys.js'
import { applyCompletion, completionRequestForInput, scoreSlashMenuItem } from '../hermes/completion.js'
import { oneLine } from '../view/describe.js'
import { rpc } from '../wire/rpc.js'

import type { OverlayHost } from './overlay.js'

const DEBOUNCE_MS = 60
/** A row's room in px for its name and description in the 736px list (view/styles.ts), and their faces' rough widths per character. */
const ROW_PX = 666
const NAME_PX = 7.4
const DETAIL_PX = 6.4
type CompletionKind = 'path' | 'skill' | 'slash'
type Answer = { revision: bigint; owner: unknown; sid: string | null; cursor: number; kind: CompletionKind }

/** The composer's completion list: queries the gateway as the text before the caret changes and accepts rows into it. */
export class Completion {
  items: CompletionItem[] = []
  selected = 0
  /** Where an accepted row's text replaces the input. */
  #replaceFrom = 0
  /** The text before the caret the items answer. */
  #for = ''
  /** The text before the caret last queried (scheduled, in flight or answered); null until the first update. */
  #asked: { before: string; revision: bigint; owner: unknown } | undefined
  #answer: Answer | undefined
  /** Bumped by every new query and every dismissal: replies of an older generation are dropped. */
  #gen = 0
  #pending = false
  #timer: NodeJS.Timeout | undefined
  #composer: Composer | undefined
  readonly #host: OverlayHost
  readonly #gw: GatewayClient
  readonly #sid: () => string | null
  readonly #owner: () => unknown

  constructor(host: OverlayHost, gw: GatewayClient, sid: () => string | null, owner: () => unknown = sid) {
    this.#host = host
    this.#gw = gw
    this.#sid = sid
    this.#owner = owner
  }

  get open(): boolean {
    return this.items.length > 0
  }

  /** The dim suffix the selected row would add after the caret, while the live text still leads to it. */
  get ghost(): string {
    const row = this.items[this.selected]
    const composer = this.#composer

    if (!row || !composer || !this.#current() || composer.cursor !== composer.text.length) {
      return ''
    }

    const next = applyCompletion(this.#for, row.text, this.#replaceFrom)

    return next.startsWith(composer.text) ? next.slice(composer.text.length) : ''
  }

  /** Re-queries when the text before the composer's caret changed since the last query; cheap otherwise. */
  update(composer: Composer) {
    this.#composer = composer
    const before = composer.text.slice(0, composer.cursor)
    const revision = composer.revision
    const owner = this.#owner()
    const sid = this.#sid()

    if (before === this.#asked?.before && revision === this.#asked.revision && owner === this.#asked.owner) {
      return
    }

    this.#asked = { before, owner, revision }
    const gen = ++this.#gen
    this.#answer = undefined
    if (this.items.length) {
      this.items = []
      this.#host.changed()
    }
    clearTimeout(this.#timer)
    this.#timer = undefined
    const request = requestFor(before, sid)

    if (!request) {
      this.dismiss()

      return
    }

    this.#pending = true
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      if (gen !== this.#gen || composer.revision !== revision || this.#owner() !== owner || this.#sid() !== sid ||
          composer.anchor !== undefined) {
        if (gen === this.#gen) { this.#pending = false }
        return
      }
      const params =
        request.method === 'complete.slash' && sid ? { ...request.params, session_id: sid } : request.params

      rpc(this.#gw, request.method, params)
        // Either method's answer: only complete.slash's says where its replacement starts.
        .then((r: CompleteSlashResult) => {
          if (gen === this.#gen) { this.#pending = false }
          if (gen !== this.#gen || composer.revision !== revision || this.#owner() !== owner || this.#sid() !== sid ||
              composer.text.slice(0, composer.cursor) !== before || composer.anchor !== undefined) {
            return
          }

          const replaceFrom = request.method === 'complete.slash' && !request.skillsOnly
            ? slashOffset(request.params.text, r?.replace_from)
            : request.replaceFrom

          if (replaceFrom === undefined) {
            this.dismiss()
            return
          }

          const items = r?.items ?? []
          this.items =
            request.method !== 'complete.slash'
              ? items
              : request.skillsOnly
                ? items.filter(i => i.kind === 'skill')
                : slashItems(items, before)
          this.selected = 0
          this.#for = before
          this.#replaceFrom = replaceFrom
          this.#answer = { cursor: composer.cursor, kind: request.method === 'complete.path' ? 'path' : request.skillsOnly ? 'skill' : 'slash', owner, revision, sid }
          this.#host.changed()
        })
        .catch(() => {
          if (gen === this.#gen) {
            this.dismiss()
          }
        })
    }, DEBOUNCE_MS)
  }

  /** Hides the list and drops pending queries; it reopens once the text before the caret changes. */
  dismiss() {
    this.#gen++
    this.#pending = false
    clearTimeout(this.#timer)
    this.#timer = undefined

    if (this.items.length) {
      this.items = []
      this.#host.changed()
    }

    this.#for = ''
    this.#answer = undefined
  }

  /** Keys while the list is open: ↑/↓ move, Tab accepts, Enter accepts a changing row, Esc closes. */
  onKey(key: Key): boolean {
    const composer = this.#composer

    if (!this.open || !composer) {
      if (key.name === 'escape' && this.#pending) {
        this.dismiss()
        return true
      }
      return false
    }

    if ((key.name === 'tab' || (key.name === 'enter' && !key.shift && !key.alt)) && !this.#current()) {
      this.dismiss()
      return true
    }

    // Walking the prompt history: ↑/↓ keep walking it, though a recalled entry opened the list.
    if (composer.browsing && (key.name === 'up' || key.name === 'down')) {
      return false
    }

    switch (key.name) {
      case 'up':
        this.selected = (this.selected - 1 + this.items.length) % this.items.length

        return true

      case 'down':
        this.selected = (this.selected + 1) % this.items.length

        return true

      case 'escape':
        this.dismiss()

        return true

      case 'tab':
        return this.#accept(applyCompletion(this.#for, this.items[this.selected]?.text ?? '', this.#replaceFrom))
      case 'enter': {
        // A list answering older text (keys outran the render) must not rewrite what was typed since.
        if (key.shift || key.alt || composer.text.slice(0, composer.cursor) !== this.#for) {
          return false
        }

        const row = this.items[this.selected]
        const answer = this.#answer
        if (!row || !answer) { return false }
        const next = applyCompletion(this.#for, row.text, this.#replaceFrom)
        const remaining = tokenTail(composer.text.slice(composer.cursor), answer.kind)
        const existing = this.#for + remaining

        if (next === existing || next.trimEnd() === existing.trimEnd()) {
          this.dismiss()

          return false
        }

        return this.#accept(next)
      }

      default:
        return false
    }
  }

  /** The overlay nodes for the `layer` region (none while closed): the list sits above the composer
   * node `composerId` at a fixed place, not at the caret, so it does not move as the user types. */
  nodes(composerId: string): JSX.Element[] {
    if (!this.open) {
      return []
    }

    const key = `complete-${this.#gen}`
    const listId = `layer.${key}.select.list`
    const answer = this.#answer
    const items = this.items
    // While any row is cut off, the footer shows the highlighted row's whole description: shown for
    // the list, not per row, so the list keeps its height as the highlight moves.
    const more = this.items.some(cutOff) ? detailOf(this.items[this.selected]) : undefined

    return [
      <overlay anchor={{ node: composerId, side: 'above' }} key={key} role="omp.autocomplete">
        <col key="select" role="omp.select">
          <list
            empty={this.#for.includes('@') ? 'No files' : 'No items'}
            key="list"
            max={{ lines: 8 }}
            onActivate={ev => this.#pick(ev.item, listId, { accept: true }, answer, items)}
            onSelect={ev => this.#pick(ev.item, listId, { accept: false }, answer, items)}
            selected={`${listId}.${this.selected}`}
          >
            {this.items.map((item, i) => (
              <item
                key={String(i)}
                {...optional('detail', detailOf(item))}
                icon={iconOf(item)}
                label={labelOf(item, this.#for, this.#replaceFrom)}
                role={`hermes.complete.${isPath(item) ? 'path' : item.kind === 'skill' ? 'skill' : 'command'}`}
              />
            ))}
          </list>
          {more ? (
            <text key="more" lines={3} role="hermes.complete.more" text={more} wrap="word" />
          ) : null}
        </col>
      </overlay>
    ]
  }

  #pick(itemId: string, listId: string, { accept }: { accept: boolean }, answer: Answer | undefined, items: CompletionItem[]) {
    if (answer !== this.#answer || items !== this.items || !this.#current() || !itemId.startsWith(listId + '.')) {
      return
    }
    const i = Number(itemId.slice(listId.length + 1))

    if (Number.isInteger(i) && this.items[i]) {
      this.selected = i

      if (accept) {
        this.#accept(applyCompletion(this.#for, this.items[i].text, this.#replaceFrom))
      }

      this.#host.changed()
    }
  }

  /** Replaces the text before the caret with `before`; false when the items answer older text than the live one. */
  #accept(before: string): boolean {
    const composer = this.#composer

    if (!composer || !this.#current()) {
      return false
    }

    const answer = this.#answer
    if (!answer) { return false }
    const tail = composer.text.slice(composer.cursor)
    // Quotes, escaped paths and punctuation are ambiguous without a gateway token-end contract.
    // Refuse rather than delete text that might belong outside the completion.
    const token = tokenTail(tail, answer.kind)
    const typed = this.#for.slice(this.#replaceFrom)
    if (/[\\'"`]/.test(typed + token) || (token && (/[()[\]{},;!?]/.test(token) || token.includes('/') || token.endsWith('.'))) ||
        (answer.kind === 'path' && /\s/.test(before.slice(this.#replaceFrom))) ||
        boundaryAt(composer.text, this.#replaceFrom) !== this.#replaceFrom ||
        boundaryAt(composer.text, composer.cursor) !== composer.cursor ||
        boundaryAt(composer.text, composer.cursor + token.length) !== composer.cursor + token.length) {
      this.dismiss()
      return true
    }
    const end = composer.cursor + token.length

    // A finished `@` mention takes one space after it, like t3code: the list closes and typing goes on.
    // Folders (`/`) and kinds (`@file:`) stay open to keep picking; a space already there is reused.
    const finished = /(?:^|\s)@[^\s]*[^\s/:]$/.test(before)
    const hasSpace = composer.text[end] === ' '
    const replacement = finished ? `${before} ` : before
    const reuseSpace = hasSpace && replacement.endsWith(' ')
    composer.splice(0, end + (reuseSpace ? 1 : 0), replacement)
    this.dismiss()
    this.update(composer)

    return true
  }

  #current(): boolean {
    const c = this.#composer
    const a = this.#answer
    return Boolean(c && a && c.revision === a.revision && c.cursor === a.cursor && c.anchor === undefined &&
      this.#owner() === a.owner && this.#sid() === a.sid && c.text.slice(0, c.cursor) === this.#for)
  }
}

function tokenTail(tail: string, kind: CompletionKind): string {
  return (kind === 'skill' ? /^[\w-]*/ : /^\S*/).exec(tail)?.[0] ?? ''
}

/** Hermes reports slash offsets as Python code points; Tern and JavaScript use UTF-16. */
function slashOffset(input: string, offset: number | null | undefined): number | undefined {
  const points = [...input]
  const lastSpace = points.lastIndexOf(' ')
  const details = input.toLowerCase() === '/details'
  const actual = offset ?? (lastSpace < 0 && !details ? 1 : undefined)
  return actual !== undefined && Number.isSafeInteger(actual) && actual >= 1 && actual <= points.length &&
    (lastSpace < 0 ? details ? actual === points.length : actual === 1 : actual === lastSpace + 1)
    ? points.slice(0, actual).join('').length
    : undefined
}

/**
 * A command's completion rows for `typed` (the draft's `/…` text): the gateway's, minus the hidden
 * commands this frontend cannot run, and this frontend's own commands (/ps, /prs, …) that match the
 * typed name, ranked among the gateway's commands by the same name tiers (skills stay last).
 */
export function slashItems(items: readonly CompletionItem[], typed: string): CompletionItem[] {
  const word = (text: string) => text.replace(/^\//, '').split(/\s/)[0]?.toLowerCase() ?? ''

  // A hidden command's own arguments (`/details hidden`) are no use either.
  if (HIDDEN_COMMANDS.has(word(typed))) {
    return []
  }

  const kept = items.filter(i => !(i.kind === 'command' && HIDDEN_COMMANDS.has(word(i.text))))

  // Past the name (`/theme `) the rows are the command's arguments.
  if (/\s/.test(typed)) {
    return kept
  }

  const query = typed.slice(1).toLowerCase()
  const listed = new Set(kept.map(i => word(i.text)))
  const rank = (item: CompletionItem, aliases: readonly string[] = []) =>
    query ? scoreSlashMenuItem({ aliases: [...aliases], description: item.meta ?? '', id: word(item.text) }, query) : 1

  const own = localCommands().flatMap(c =>
    c.help && !listed.has(c.name)
      ? [{ aliases: c.aliases, item: { display: `/${c.name}`, kind: 'command', meta: c.help, text: `/${c.name}` } }]
      : []
  )

  const commands = [
    ...kept.filter(i => i.kind !== 'skill').map(item => ({ item, score: rank(item) })),
    // Ours match by name or alias only: their help words ("the", "and") would flood every query.
    ...own.map(o => ({ item: o.item, score: rank(o.item, o.aliases) })).filter(o => o.score < 3)
  ]
    // Stable: the gateway's order holds within a tier.
    .sort((a, b) => a.score - b.score)
    .map(o => o.item)

  return [...commands, ...kept.filter(i => i.kind === 'skill')]
}

/** Icons for hermes's common commands; others fall back by kind. */
const COMMAND_ICONS: Record<string, string> = {
  clear: 'eraser',
  compress: 'compress',
  cron: 'clock',
  help: 'help',
  history: 'history',
  model: 'sparkle',
  new: 'plus',
  personality: 'user',
  quit: 'log-out',
  reasoning: 'brain',
  resume: 'play',
  retry: 'repeat',
  save: 'save',
  skills: 'skill',
  tools: 'tools',
  undo: 'undo',
  usage: 'gauge',
  yolo: 'shield-alert'
}

/** A path row: `@file:src/a.ts` / `@folder:src/`, or a bare listing entry. */
function isPath(item: CompletionItem): boolean {
  return !item.kind && !item.text.startsWith('/')
}

/** The row's description on one line; Hermes' `⚡ ` before a skill's says what the skill icon already does. */
function detailOf(item: CompletionItem | undefined): string | undefined {
  return item?.meta && item.meta !== 'dir' ? oneLine(item.meta).replace(/^⚡\s*/u, '') || undefined : undefined
}

/** Whether the row's description likely runs past its end (the name takes at most 40% of the row). */
function cutOff(item: CompletionItem): boolean {
  const name = Math.min((item.display || item.text).length * NAME_PX, ROW_PX * 0.4)

  return name + (detailOf(item)?.length ?? 0) * DETAIL_PX > ROW_PX
}

function iconOf(item: CompletionItem): string {
  if (isPath(item)) {
    return (item.display || item.text).endsWith('/') ? 'folder' : 'file'
  }

  if (item.kind === 'skill') {
    return 'skill'
  }

  return COMMAND_ICONS[item.text.replace(/^\//, '').split(/\s/)[0] ?? ''] ?? 'slash'
}

/** The row's label (without the leading `/`) with the typed text marked; path names are strong like omp's. */
function labelOf(item: CompletionItem, typed: string, replaceFrom: number) {
  const label = (item.display || item.text).replace(/^\//, '')
  const base = isPath(item) ? 'strong' : undefined

  const query =
    typed
      .slice(replaceFrom)
      .replace(/^[/@]/, '')
      .replace(/^(file|folder):/, '')
      .split('/')
      .pop() ?? ''

  const at = query ? label.toLowerCase().indexOf(query.toLowerCase()) : -1

  if (at < 0) {
    return [{ ...optional('s', base), t: label }]
  }

  return [
    { ...optional('s', base), t: label.slice(0, at) },
    { s: base ? `${base} mark` : 'mark', t: label.slice(at, at + query.length) },
    { ...optional('s', base), t: label.slice(at + query.length) }
  ].filter(s => s.t)
}

/**
 * The completion for the caret's line. Past the first line only skill references and paths
 * complete: a slash command is the draft's first token, so `/name` there is a skill reference too.
 */
function requestFor(before: string, sid: string | null) {
  const lineStart = before.lastIndexOf('\n') + 1
  const request = completionRequestForInput(before.slice(lineStart), { sid })

  if (!request || !lineStart) {
    return request
  }

  return request.method === 'complete.slash'
    ? { ...request, replaceFrom: request.replaceFrom + lineStart, skillsOnly: true }
    : { ...request, replaceFrom: request.replaceFrom + lineStart }
}
