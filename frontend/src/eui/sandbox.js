// The DOM sandbox the vendored ephemeral-ui cards run in: linkedom plus the few browser globals the
// kit touches, inside a node:vm context. The kit's own make()/play()/listeners run unchanged; the host
// only reads the resulting DOM (snapshot) and replays a user's click into it (click).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

import { parseHTML } from 'linkedom'

const SVG = 'http://www.w3.org/2000/svg'
const CLICKY = new Set(['click', 'pointerdown', 'pointerup', 'dblclick', 'change', 'input'])
const NATIVE = new Set(['button', 'a', 'summary', 'input', 'select', 'label'])
const remote = {}

/** The first directory holding the vendored kit: beside the source, or the bundle's ../src copy. */
export function vendorDir(candidates) {
  return candidates.find(d => existsSync(join(d, 'kit.js'))) ?? ''
}

export async function createSandbox(dir, scheme = 'light', log = () => {}) {
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
  const listened = new WeakMap()
  const EP = window.Element.prototype
  const add = EP.addEventListener
  EP.addEventListener = function (type, fn, opts) {
    const s = listened.get(this) ?? new Set()
    s.add(type)
    listened.set(this, s)
    return add.call(this, type, fn, opts)
  }
  EP.animate = function (frames, opts) {
    const ms = typeof opts === 'number' ? opts : Number(opts?.duration ?? 0)
    let done
    const a = { finished: new Promise(r => (done = r)), currentTime: 0, playState: 'running', onfinish: null, cancel() { clearTimeout(t); this.playState = 'idle' }, finish() {}, play() {}, pause() {}, reverse() {}, addEventListener() {} }
    const last = Array.isArray(frames) ? frames.at(-1) : undefined
    const t = setTimeout(() => {
      a.currentTime = ms
      a.playState = 'finished'
      // fill: forwards leaves the last keyframe applied, as a browser would.
      if (last && (opts?.fill === 'forwards' || opts?.fill === 'both')) for (const [k, v] of Object.entries(last)) if (k !== 'offset' && k !== 'easing') try { this.style[k] = v } catch {}
      try { a.onfinish?.() } catch (e) { log(e) }
      done(a)
    }, Math.max(0, ms))
    t.unref?.()
    return a
  }
  EP.getAnimations = () => []
  EP.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 320, height: 24, right: 320, bottom: 24 })
  EP.scrollIntoView = function () {}
  EP.scrollTo = function () {}
  EP.setPointerCapture = function () {}
  EP.releasePointerCapture = function () {}
  EP.focus ??= function () {}
  EP.blur ??= function () {}

  const timer = f => (fn, ms, ...a) => { const t = f(() => { try { fn(...a) } catch (e) { log(e) } }, ms); t.unref?.(); return t }
  const data = name => join(dir, 'data', name.replace(/^.*data\//, '').replace(/[?#].*$/, ''))
  const pin = JSON.parse(readFileSync(join(dir, 'PIN.json'), 'utf8'))
  // A fixture not vendored comes from the kit repo at the pinned commit, once per process.
  const dataText = name => {
    const file = data(name)
    if (existsSync(file)) return Promise.resolve(readFileSync(file, 'utf8'))
    const base = file.slice(join(dir, 'data').length + 1)
    if (!/^[a-z0-9-]+\.json$/.test(base) || !pin.remoteData) return Promise.resolve(undefined)
    return (remote[base] ??= globalThis.fetch(pin.remoteData + base).then(r => (r.ok ? r.text() : undefined)).catch(() => undefined))
  }
  const ctx = {
    window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, SVGElement: window.SVGElement,
    Event: window.Event, CustomEvent: window.CustomEvent, KeyboardEvent: window.KeyboardEvent ?? window.Event, PointerEvent: window.Event,
    MouseEvent: window.MouseEvent ?? window.Event, DocumentFragment: window.DocumentFragment, Text: window.Text, MutationObserver: window.MutationObserver,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: q => ({ matches: /reduce/.test(q) || (/dark/.test(q) && scheme === 'dark'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {} }),
    requestAnimationFrame: f => timer(setTimeout)(() => f(performance.now()), 16), cancelAnimationFrame: clearTimeout,
    setTimeout: timer(setTimeout), clearTimeout, setInterval: timer(setInterval), clearInterval, performance, queueMicrotask, structuredClone, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, Intl,
    console: { log() {}, info() {}, debug() {}, warn() {}, error: (...a) => log(a[0]) },
    IntersectionObserver: class { observe() {} disconnect() {} unobserve() {} },
    ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} }, vibrate() {}, userAgent: 'tern' },
    location: { hash: '', search: '', href: 'https://kvnloo.github.io/ephemeral-ui/', origin: 'https://kvnloo.github.io' },
    history: { replaceState() {}, pushState() {} },
    innerWidth: 720, innerHeight: 900, devicePixelRatio: 1, scrollY: 0, scrollTo() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    fetch: async url => {
      const text = await dataText(String(url))
      if (text === undefined) return { ok: false, status: 404, json: async () => { throw Error(`404 ${url}`) }, text: async () => '' }
      return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text }
    }
  }
  // Inert stand-ins for browser APIs a few controls touch: text selection and hit-testing.
  ctx.getSelection = () => ({ removeAllRanges() {}, addRange() {}, selectAllChildren() {}, collapseToEnd() {}, toString: () => '' })
  document.elementFromPoint ??= () => null
  document.createRange ??= () => ({ selectNodeContents() {}, setStart() {}, setEnd() {} })
  window.HTMLElement.prototype.select ??= function select() {}
  // linkedom has no select.value/selectedIndex; the kit's change handlers read them.
  const optionsOf = sel => [...sel.querySelectorAll('option')]
  const chosen = sel => Math.max(0, optionsOf(sel).findIndex(o => o.hasAttribute('selected')))
  const choose = (sel, i) => { for (const [j, o] of optionsOf(sel).entries()) o.toggleAttribute('selected', j === i) }
  Object.defineProperties(window.HTMLSelectElement.prototype, {
    options: { configurable: true, get() { return optionsOf(this) } },
    selectedIndex: { configurable: true, get() { return optionsOf(this).length ? chosen(this) : -1 }, set(i) { choose(this, i) } },
    value: { configurable: true, get() { const o = optionsOf(this)[chosen(this)]; return o ? (o.getAttribute('value') ?? o.textContent) : '' }, set(v) { choose(this, optionsOf(this).findIndex(o => (o.getAttribute('value') ?? o.textContent) === String(v))) } }
  })
  Object.defineProperty(window.HTMLOptionElement.prototype, 'selected', { configurable: true, get() { const sel = this.closest('select'); return sel ? optionsOf(sel)[chosen(sel)] === this : this.hasAttribute('selected') }, set(v) { const sel = this.closest('select'); if (sel && v) choose(sel, optionsOf(sel).indexOf(this)) } })
  ctx.self = ctx
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(readFileSync(join(dir, 'kit.js'), 'utf8'), ctx, { filename: 'ephemeral-ui/kit.js' })
  const K = ctx.__EUI
  await K.loadApps()
  const themes = JSON.parse(readFileSync(data('themes.json'), 'utf8')).themes
  K.theme.themes = themes
  K.theme.base = themes.find(t => t.id === (scheme === 'dark' ? 't3-dark' : 't3-light'))
  K.motion.speed = 1

  const ids = new WeakMap()
  const byId = new Map()
  let next = 1
  const idOf = el => { let i = ids.get(el); if (!i) { i = next++; ids.set(el, i); byId.set(i, new WeakRef(el)) } return i }
  const clickable = el => NATIVE.has(el.localName) || el.hasAttribute('onclick') || [...(listened.get(el) ?? [])].some(t => CLICKY.has(t))

  function snapshot(el) {
    if (el.nodeType === 3) return el.data.trim() || el.data.includes(' ') ? { t: 'text', text: el.data } : null
    if (el.nodeType !== 1) return null
    if (el.namespaceURI === SVG || el.localName === 'svg') {
      if (el.localName !== 'svg') return null
      const box = (el.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
      const w = Number.parseFloat(el.getAttribute('width') ?? '') || box[2] || 16
      const h = Number.parseFloat(el.getAttribute('height') ?? '') || box[3] || 16
      const svg = el.outerHTML.includes('xmlns=') ? el.outerHTML : el.outerHTML.replace('<svg', `<svg xmlns="${SVG}"`)
      return { t: 'svg', svg, w, h, cls: el.getAttribute('class') ?? '', style: el.getAttribute('style') ?? '' }
    }
    if (el.localName === 'canvas' || el.localName === 'script' || el.localName === 'style' || el.localName === 'template') return null
    const attrs = {}
    for (const { name, value } of el.attributes) if (/^(data-|aria-|role$|colspan$|rowspan$|type$|value$|placeholder$|title$|disabled$|checked$)/.test(name)) attrs[name] = value
    if (el.localName === 'input' && (el.type === 'checkbox' || el.type === 'radio')) attrs.checked = el.checked ? 'true' : ''
    if (el.localName === 'input' && !('type' in attrs)) attrs.type = el.type ?? 'text'
    if (el.localName === 'input' || el.localName === 'textarea') attrs.value = String(el.value ?? attrs.value ?? '')
    if (el.hidden) attrs.hidden = 'true'
    if (el.disabled) attrs.disabled = 'true'
    const kids = []
    // A closed details shows only its summary; a select shows only its chosen option.
    const shown = el.localName === 'details' && !el.hasAttribute('open') ? [...el.children].filter(k => k.localName === 'summary')
      : el.localName === 'select' ? [...el.options].filter(o => o.selected).slice(0, 1)
      : el.childNodes
    if (el.localName === 'details') attrs.open = el.hasAttribute('open') ? 'true' : ''
    for (const k of shown) { const s = snapshot(k); if (s) kids.push(s) }
    return { t: 'el', tag: el.localName, id: idOf(el), cls: el.getAttribute('class') ?? '', style: el.getAttribute('style') ?? '', attrs, click: clickable(el), kids }
  }

  const fire = (el, type) => {
    const e = new window.Event(type, { bubbles: true, cancelable: true })
    Object.assign(e, { button: 0, buttons: 1, clientX: 0, clientY: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, detail: 1 })
    try { el.dispatchEvent(e) } catch (err) { log(err) }
    return e
  }

  return {
    kinds: Object.keys(K.KINDS),
    apps: () => K.catalog.apps.map(a => ({ id: a.id, name: a.name, kinds: [...(a.kinds ?? [])] })),
    mount(kind, appId, onChange) {
      const k = K.KINDS[kind]
      if (!k) throw Error(`ephemeral-ui has no kind ${kind}`)
      const app = K.catalog.byId[appId] ?? K.catalog.apps.find(a => (a.kinds ?? []).includes(kind)) ?? { id: appId, name: appId, kinds: [kind] }
      const root = document.createElement('div')
      root.setAttribute('data-eui', 'card')
      root.setAttribute('data-eui-kind', kind)
      root.setAttribute('data-eui-app', app.id)
      if (scheme === 'dark') root.classList.add('dark')
      document.body.append(root)
      const c = k.make(app, K.rng(app.id + kind))
      root.append(c.el ?? c)
      const run = new K.Run()
      if (typeof c.play === 'function') Promise.resolve().then(() => c.play(run)).catch(e => { if (e !== K.Run.CANCEL) log(e) })
      let pending
      const mo = new window.MutationObserver(() => { if (!pending) { pending = setTimeout(() => { pending = undefined; onChange() }, 120); pending.unref?.() } })
      mo.observe(root, { subtree: true, childList: true, attributes: true, characterData: true })
      return {
        app: app.id,
        label: String(k.label ?? kind),
        snapshot: () => snapshot(root),
        click(id) {
          const el = byId.get(id)?.deref()
          if (!el || !root.contains(el) || el.disabled) return false
          if (el.localName === 'input' && (el.type === 'checkbox' || el.type === 'radio')) { el.checked = el.type === 'radio' ? true : !el.checked; fire(el, 'input'); fire(el, 'change'); return true }
          fire(el, 'pointerdown')
          // A hold button confirms when its fill animation finishes; releasing early cancels it.
          if (el.closest('.hold')) return true
          fire(el, 'pointerup')
          const clicked = fire(el, 'click')
          // A browser's default actions, which the DOM here lacks: a summary opens and closes its
          // details, and a select (drawn as a single chip in Tern) steps to its next option.
          const summary = el.closest('summary')
          const details = summary?.parentElement
          if (!clicked.defaultPrevented && details?.localName === 'details' && details.firstElementChild === summary) {
            details.toggleAttribute('open')
            details.dispatchEvent(new window.Event('toggle'))
          }
          const label = el.closest('label')
          const box = label && (label.htmlFor ? root.querySelector(`[id="${String(label.htmlFor).replace(/"/g, '')}"]`) : label.querySelector('input'))
          if (!clicked.defaultPrevented && box && box !== el && (box.type === 'checkbox' || box.type === 'radio') && !box.disabled) {
            box.checked = box.type === 'radio' ? true : !box.checked
            fire(box, 'input'); fire(box, 'change')
          }
          if (el.localName === 'select' && el.options.length > 1) {
            el.selectedIndex = (el.selectedIndex + 1) % el.options.length
            fire(el, 'input'); fire(el, 'change')
          }
          return true
        },
        dispose() { mo.disconnect(); run.stop(); clearTimeout(pending); root.remove() }
      }
    }
  }
}
