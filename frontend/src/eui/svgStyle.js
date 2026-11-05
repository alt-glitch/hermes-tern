// A card's inline SVG reaches Tern as an image, outside the page: the kit's CSS classes, custom
// properties and currentColor no longer apply there. svgInline() bakes them in while the live
// sandbox DOM is still around, so the image draws the same as the card on the kit site.

// Declarations an SVG renderer honours as presentation; the rest (transitions, cursors) do nothing in an image.
const KEEP = /^(fill|fill-opacity|stroke|stroke-width|stroke-opacity|stroke-dasharray|stroke-dashoffset|stroke-linecap|stroke-linejoin|opacity|font-size|font-family|font-weight|text-anchor|dominant-baseline|display|visibility|stop-color|stop-opacity)$/
const SCOPE = "[data-eui='card'] "
const DARK = '[data-scheme="dark"] '

/** The kit's SVG presentation rules for one scheme, in sheet order: [{ sel, decls: [[prop, value]] }]. */
export function svgRules(css, scheme) {
  const out = []
  for (const [, head, body] of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const decls = body.split(';').map(d => d.split(':')).filter(([p, ...v]) => p && v.length && KEEP.test(p.trim()))
      .map(([p, ...v]) => [p.trim(), v.join(':').trim()])
    if (!decls.length) continue
    const sels = head.split(',').map(s => s.trim().replace(SCOPE, '')).filter(s => {
      if (/:(hover|focus|active|focus-visible)/.test(s)) return false
      return scheme === 'dark' || !s.includes(DARK.trim())
    }).map(s => s.replace(DARK, ''))
    if (sels.length) out.push({ sel: sels.join(', '), decls })
  }
  return out
}

/** `theme` field for each host token the kit's sheet names (--h-fg is theme.fg). */
const tokenOf = name => name.startsWith('--h-') ? name.slice(4).replace('card-solid', 'card') : undefined

/** Resolves var(), currentColor, color-mix() and CSS4 colour syntax to values a plain SVG renderer reads. */
export function resolveValue(value, lookup, depth = 0) {
  let v = value
  for (let i = 0; i < 8 && v.includes('var('); i++) {
    v = v.replace(/var\((--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (_, name, fb) => lookup(name) ?? (fb === undefined ? '' : fb.trim()))
  }
  if (v.includes('currentColor') && depth === 0) v = v.replace(/currentColor/g, lookup('color') ?? '')
  v = v.replace(/color-mix\(in srgb,\s*([^,]+?)\s+([\d.]+)%\s*,\s*([^)]+?(?:\([^)]*\))?)\s*\)/g, (_, a, p, b) => mix(a, Number(p) / 100, b) ?? _)
  v = v.replace(/rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?))?\s*\)/g, (_, r, g, b, a) => a === undefined ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a.endsWith('%') ? Number.parseFloat(a) / 100 : a})`)
  v = v.replace(/hsla?\(\s*([\d.]+)(?:deg)?\s+([\d.]+%)\s+([\d.]+%)\s*\)/g, (_, h, s, l) => `hsl(${h},${s},${l})`)
  return v
}

function rgba(c) {
  c = c.trim()
  if (c === 'transparent') return [0, 0, 0, 0]
  let m = /^#([0-9a-f]{3,8})$/i.exec(c)
  if (m) {
    const h = m[1].length < 6 ? [...m[1]].map(x => x + x).join('') : m[1]
    return [0, 2, 4].map(i => Number.parseInt(h.slice(i, i + 2), 16)).concat(h.length === 8 ? Number.parseInt(h.slice(6), 16) / 255 : 1)
  }
  m = /^rgba?\(([^)]*)\)$/.exec(c)
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number.parseFloat)
    return p.length >= 3 ? [p[0], p[1], p[2], p[3] ?? 1] : undefined
  }
  return undefined
}

function mix(a, p, b) {
  const x = rgba(a), y = rgba(b)
  if (!x || !y) return undefined
  const al = x[3] * p + y[3] * (1 - p)
  const ch = i => al === 0 ? 0 : Math.round((x[i] * x[3] * p + y[i] * y[3] * (1 - p)) / al)
  return `rgba(${ch(0)},${ch(1)},${ch(2)},${+al.toFixed(3)})`
}

const props = style => Object.fromEntries((style ?? '').split(';').map(d => d.split(':')).filter(([p, ...v]) => p && v.length).map(([p, ...v]) => [p.trim(), v.join(':').trim()]))

/** Path length of a line or circle, for the kit's pathLength-normalised dashes (undefined for paths). */
function lengthOf(el) {
  const n = k => Number.parseFloat(el.getAttribute(k) ?? '0')
  if (el.localName === 'line') return Math.hypot(n('x2') - n('x1'), n('y2') - n('y1'))
  if (el.localName === 'circle') return 2 * Math.PI * n('r')
  return undefined
}

/**
 * The SVG `svg` (a live sandbox element) as standalone markup: every element's matched kit rules,
 * inline style and inherited custom properties resolved into its style attribute.
 */
export function svgInline(svg, rules, theme) {
  const copy = svg.cloneNode(true)
  const live = [svg, ...svg.querySelectorAll('*')]
  const out = [copy, ...copy.querySelectorAll('*')]
  // Custom properties and colour inherited from the card down to the svg.
  const inherited = {}
  for (let a = svg.parentElement; a; a = a.parentElement) {
    for (const [k, v] of Object.entries(props(a.getAttribute('style')))) if (!(k in inherited) && (k.startsWith('--') || k === 'color')) inherited[k] = v
  }
  const scope = new Map([[svg, inherited]])
  live.forEach((el, i) => {
    const up = scope.get(el.parentElement) ?? inherited
    const decl = {}
    for (const r of rules) {
      let hit = false
      try { hit = el.matches(r.sel) } catch { hit = false }
      if (hit) for (const [p, v] of r.decls) decl[p] = v
    }
    const own = props(el.getAttribute('style'))
    Object.assign(decl, own)
    const vars = { ...up }
    for (const [k, v] of Object.entries(own)) if (k.startsWith('--') || k === 'color') vars[k] = v
    scope.set(el, vars)
    const lookup = name => {
      if (name in vars) return resolveValue(vars[name], lookup, 1)
      const t = tokenOf(name)
      if (t && theme[t] !== undefined) return String(theme[t])
      return name === 'color' ? String(theme.fg) : undefined
    }
    const style = []
    for (const [p, v] of Object.entries(decl)) {
      if (p.startsWith('--') || p === 'color') continue
      const r = resolveValue(v, lookup)
      if (r && !r.includes('var(') && !r.includes('color-mix(')) style.push([p, r])
    }
    // pathLength-normalised dashes, in real units (renderers differ on pathLength).
    const pl = Number.parseFloat(el.getAttribute('pathLength') ?? '')
    if (pl > 0) {
      const len = lengthOf(el)
      const s = Object.fromEntries(style)
      let done = true
      if (len !== undefined) {
        for (const k of ['stroke-dasharray', 'stroke-dashoffset']) if (k in s) s[k] = s[k].split(/[\s,]+/).map(x => +(Number.parseFloat(x) * len / pl).toFixed(2)).join(' ')
      } else if (Number.parseFloat(s['stroke-dashoffset'] ?? '0') === 0 && Number.parseFloat(s['stroke-dasharray'] ?? `${pl}`) >= pl) {
        delete s['stroke-dasharray']; delete s['stroke-dashoffset']
      } else done = false
      style.length = 0; style.push(...Object.entries(s))
      if (done) out[i].removeAttribute('pathLength')
    }
    for (const a of ['fill', 'stroke', 'stop-color']) {
      const v = out[i].getAttribute(a)
      if (v && (v.includes('var(') || v.includes('currentColor'))) out[i].setAttribute(a, resolveValue(v, lookup))
    }
    if (style.length) out[i].setAttribute('style', style.map(([p, v]) => `${p}:${v}`).join(';'))
    else out[i].removeAttribute('style')
  })
  const markup = copy.outerHTML
  return markup.includes('xmlns=') ? markup : markup.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')
}
