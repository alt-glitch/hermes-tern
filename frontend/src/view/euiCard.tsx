// Draws one ephemeral-ui card: the kit's DOM snapshot as Tern `el` nodes, its SVG as images and
// its inline styles as stylesheet rules. A click replays into the kit, which redraws the card.
import { EL_TAGS, type ElTag, html, type JSX, ui } from '@stencil-hq/tern'

import type { EuiCards, EuiCardView } from '../eui/cards.js'
import type { EuiNode } from '../eui/sandbox.js'
import { TERN_ATTR } from '../eui/ternCss.js'

const TAGS: ReadonlySet<string> = new Set(EL_TAGS)
const BOOLEAN = new Set(['checked', 'open', 'hidden', 'disabled'])
const INLINE = new Set(['a', 'small', 'sup', 'sub', 'abbr', 'time', 's', 'u', 'var', 'cite', 'q', 'output', 'bdi', 'textarea', 'select', 'option'])

function isTag(tag: string): tag is ElTag {
  return TAGS.has(tag)
}

/** One kit element's Tern tag: its own when Tern has it, else span (inline) or div. */
function ternTag(tag: string, attrs: Readonly<Record<string, string>>): ElTag {
  if (tag === 'input') {
    return attrs['type'] === 'checkbox' || attrs['type'] === 'radio' ? 'input' : 'span'
  }

  return isTag(tag) ? tag : INLINE.has(tag) ? 'span' : 'div'
}

function convert(n: EuiNode, key: string, card: string, eui: EuiCards): JSX.Element | string | null {
  if (n.t === 'text') {
    return n.text
  }

  if (n.t === 'svg') {
    const blob = eui.svg(n.svg)
    const attrs: Record<string, string> = { 'data-eui-svg': '' }

    if (n.style) {
      attrs['data-eui-s'] = eui.style(n.style)
    }

    return blob === undefined ? null : html.span({ attrs, class: n.cls }, ui.image({ blob, w: Math.round(n.w), h: Math.round(n.h) }))
  }

  const tag = ternTag(n.tag, n.attrs)
  const attrs: Record<string, string> = {}

  for (const [k, v] of Object.entries(n.attrs)) {
    if (/^(data-|aria-)/.test(k) || k === 'role' || k === 'colspan' || k === 'rowspan') {
      attrs[k] = v
    }

    // Tern matches attribute selectors on data-* only: mirror the rest for the kit's state rules.
    // The snapshot writes '' for an unset boolean (checked, open), which must not match [open].
    if (!k.startsWith('data-') && (v !== '' || !BOOLEAN.has(k))) {
      attrs[`${TERN_ATTR}${k}`] = v
    }
  }

  if (tag !== n.tag) {
    attrs['data-eui-tag'] = n.tag
  }

  if (n.style) {
    attrs['data-eui-s'] = eui.style(n.style)
  }

  const kids = n.kids.map((k, i) => convert(k, k.t === 'el' ? `n${k.id}` : `${key}.${i}`, card, eui))

  if (n.tag === 'input' && tag === 'span') {
    kids.push(n.attrs['value'] || n.attrs['placeholder'] || '')
  }

  return ui.el({
    key,
    tag,
    attrs,
    class: n.cls,
    ...(n.attrs['hidden'] ? { hidden: true } : {}),
    ...(n.attrs['disabled'] ? { disabled: true } : {}),
    ...(tag === 'input' ? { type: n.attrs['type'] ?? 'checkbox', checked: Boolean(n.attrs['checked']) } : {}),
    ...(n.attrs['title'] ? { title: n.attrs['title'] } : {}),
    ...(n.click ? { onClick: () => { eui.click(card, n.id) } } : {})
  }, kids)
}

/** The card for one fence; `card` is the transcript-wide card key. */
export function euiCardNode(card: string, view: EuiCardView, eui: EuiCards): JSX.Element {
  if (view.error !== undefined || !view.node) {
    return (
      <col key={card} role="eui.card.pending">
        <text key="t" role={view.error === undefined ? 'eui.pending' : 'eui.error'} text={view.error === undefined ? `ephemeral-ui · ${view.spec.kind} · ${view.spec.app}…` : `ephemeral-ui ${view.spec.kind}: ${view.error}`} />
      </col>
    )
  }

  const root = view.node

  return html.div({ key: card, attrs: { 'data-eui': 'card', 'data-eui-kind': view.spec.kind, 'data-eui-app': view.app }, class: root.t === 'el' ? root.cls : '', role: 'eui.card' },
    root.t === 'el' ? root.kids.map((k, i) => convert(k, k.t === 'el' ? `n${k.id}` : `t${i}`, card, eui)) : [])
}
