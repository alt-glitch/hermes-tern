// The CSS Tern 0.9.9 parses, for the kit's sheet (scripts/vendor-ephemeral-ui.mjs) and its inline
// styles (cards.ts). Plain ES module so the vendor script imports it without a build.
// Tern 0.9.9 stops delivering pointer events to the whole window once a surface stylesheet holds a
// declaration, selector or media query its CSS parser rejects (bisected live; `tern ctl css NAME PATH`
// lists the rejects). The kit's sheet is reduced to what Tern parses: equivalents where one exists,
// otherwise the declaration or rule goes. Each reject is cosmetic in a chat card.
export const TERN_DROP = new Set(['aspect-ratio', 'text-anchor', 'vector-effect', '-webkit-appearance', 'appearance',
  '-webkit-touch-callout', 'scroll-margin-top', 'grid-template-areas', 'grid-area', 'resize', 'offset-rotate',
  'offset-anchor', 'text-underline-offset', 'text-decoration-thickness'])
// Last three: values a kind computes from layout the sandbox DOM lacks (NaNpx, undefinedpx).
export const TERN_BAD_VALUE = /color-mix\([^;]*currentColor|repeat\(\s*auto-(fill|fit)|conic-gradient|\bNaN|\bundefined|\bnull\b/i
export const TERN_BAD_SELECTOR = /:has\(|::-webkit-|::-moz-|::backdrop/
export const TERN_BAD_MEDIA = /\(\s*(pointer|hover|any-pointer|any-hover)\s*:/

/** One declaration as Tern parses it: equivalents for logical borders, dvh and env(); undefined drops it. */
export function ternDecl(decl) {
  const at = decl.indexOf(':')
  if (at < 0) { return decl }
  const prop = decl.slice(0, at).trim().toLowerCase()
  let value = decl.slice(at + 1).trim()
  if (prop.startsWith('--')) { return decl }
  if (!value || TERN_DROP.has(prop) || TERN_BAD_VALUE.test(value)) { return undefined }
  value = value.replace(/(\d)dvh\b/g, '$1vh').replace(/env\([^()]*\)/g, '0px')
  // Tern drops position:fixed on a surface with an error event; inside a card absolute is the intent.
  if (prop === 'position' && value === 'fixed') { return `${decl.slice(0, at)}:absolute` }
  if (prop === 'border-block') { return `border-top:${value};border-bottom:${value}` }
  if (prop === 'border-inline-start') { return `border-left:${value}` }
  return `${decl.slice(0, at)}:${value}`
}

/** A rule body with only the declarations Tern parses (splits on `;` outside parentheses and quotes). */
export function ternBody(body) {
  const out = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i <= body.length; i++) {
    const ch = body[i]
    if (quote) { if (ch === quote && body[i - 1] !== '\\') { quote = '' } continue }
    if (ch === '"' || ch === "'") { quote = ch } else if (ch === '(') { depth++ } else if (ch === ')') { depth-- }
    else if ((ch === ';' && depth === 0) || i === body.length) {
      const decl = body.slice(start, i).trim()
      const kept = decl ? ternDecl(decl) : undefined
      if (kept) { out.push(kept) }
      start = i + 1
    }
  }
  return out.join(';')
}
