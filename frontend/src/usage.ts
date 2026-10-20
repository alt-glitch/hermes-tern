// Parses the text of `/usage` into sections. The backend sends Markdown-ish lines (`**Title**`
// headers, `Key: value` pairs, `•` bullets), so the parser keys on section titles and tolerates
// missing or reordered sections, K/M/B suffixes and unknown sections (kept as plain text).

export interface Pair {
  key: string
  value: string
}

export interface RateLimit {
  name: string
  /** Requests or tokens left in the window. */
  left: number
  limit: number
  /** Time until the window resets, as the backend wrote it (`37m 26s`). */
  reset?: string | undefined
}

export interface Crumb {
  label: string
  tokens: number
  pct?: number | undefined
}

export type UsageSection =
  | { kind: 'limits'; title: string; items: RateLimit[] }
  | { kind: 'session'; title: string; rows: Pair[]; context?: { used: number; max: number } | undefined }
  | { kind: 'breakdown'; title: string; note?: string | undefined; items: Crumb[] }
  | { kind: 'credits'; title: string; rows: Pair[]; notes: string[] }
  | { kind: 'text'; title: string; text: string }

const HEADER = /^\s*(?:[^\p{L}\p{N}*\s]\S*\s+)?\*\*(?<title>.+?)\*\*\s*(?<inline>.*)$/u
const SUFFIX: Record<string, number> = { b: 1e9, k: 1e3, m: 1e6 }

/** `1,234`, `33.6K`, `~8.0M` → a number; NaN when it is not one. */
export function parseCount(raw: string): number {
  const m = /^~?\s*(?<digits>[\d,]*\.?\d+)\s*(?<suffix>[kmb])?$/i.exec(raw.trim())

  if (!m) {
    return NaN
  }

  // A match always has its digits; the suffix, when there, is one of SUFFIX's keys.
  const { digits = '', suffix } = m.groups ?? {}

  return Number(digits.replace(/,/g, '')) * (suffix ? (SUFFIX[suffix.toLowerCase()] ?? 1) : 1)
}

/** 132196 → `132K`, 800000 → `800K`, 8_000_000 → `8M`, 950 → `950`. */
export function compactCount(n: number): string {
  const unit = (v: number, s: string) => `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}${s}`

  if (n >= 1e9) {
    return unit(n / 1e9, 'B')
  }

  if (n >= 1e6) {
    return unit(n / 1e6, 'M')
  }

  return n >= 1e3 ? unit(n / 1e3, 'K') : String(Math.round(n))
}

function limits(inline: string): RateLimit[] {
  const out: RateLimit[] = []

  for (const part of inline.split('|')) {
    const m = /^\s*(?<name>[A-Za-z]+):\s*(?<left>[\d.,]+\s*[kmb]?)\s*\/\s*(?<limit>[\d.,]+\s*[kmb]?)(?:\s*\(resets?\s+(?<reset>.+?)\))?\s*$/i.exec(part)?.groups
    const left = m ? parseCount(m['left'] ?? '') : NaN
    const limit = m ? parseCount(m['limit'] ?? '') : NaN

    if (m && Number.isFinite(left) && limit > 0) {
      out.push({ left, limit, name: (m['name'] ?? '').toUpperCase(), reset: m['reset'] })
    }
  }

  return out
}

function pair(line: string): Pair | undefined {
  const m = /^\s*(?<key>[^:]{1,40}):\s+(?<value>.+?)\s*$/.exec(line)?.groups

  return m ? { key: m['key'] ?? '', value: (m['value'] ?? '').replace(/^`(.*)`$/, '$1') } : undefined
}

function crumb(line: string): Crumb | undefined {
  const m = /^\s*[•\-*]\s*(?<label>.+?):\s*(?<tokens>~?[\d.,]+\s*[kmb]?)(?:\s*\(~?(?<pct>\d+(?:\.\d+)?)%\))?\s*$/i.exec(line)?.groups
  const tokens = m ? parseCount(m['tokens'] ?? '') : NaN

  return m && Number.isFinite(tokens) ? { label: m['label'] ?? '', pct: m['pct'] ? Number(m['pct']) : undefined, tokens } : undefined
}

function build(title: string, inline: string, body: string[]): UsageSection {
  const name = title.replace(/:$/, '').trim()
  const lower = name.toLowerCase()
  const lines = body.filter(l => l.trim())

  if (lower.includes('rate limit')) {
    const items = limits(inline || lines.join(' | '))

    return items.length ? { items, kind: 'limits', title: name } : text(name, inline, lines)
  }

  if (lower.includes('context breakdown')) {
    const items = lines.flatMap(l => crumb(l) ?? [])

    return items.length
      ? { items, kind: 'breakdown', note: /_\((.*?)\)_/.exec(inline)?.[1], title: name }
      : text(name, inline, lines)
  }

  if (lower.includes('session') || lower.includes('token usage')) {
    const rows: Pair[] = []
    let context: { used: number; max: number } | undefined

    for (const l of lines) {
      const p = pair(l)
      const c = p && /^context$/i.test(p.key) ? /^(?<used>[\d.,]+\s*[kmb]?)\s*\/\s*(?<max>[\d.,]+\s*[kmb]?)/i.exec(p.value)?.groups : undefined
      const used = c ? parseCount(c['used'] ?? '') : NaN
      const max = c ? parseCount(c['max'] ?? '') : NaN

      if (Number.isFinite(used) && max > 0) {
        context = { max, used }
      } else if (p) {
        rows.push(p)
      }
    }

    return rows.length || context ? { context, kind: 'session', rows, title: name } : text(name, inline, lines)
  }

  if (lower.includes('credit')) {
    const rows: Pair[] = []
    const notes: string[] = []

    for (const l of lines) {
      const p = pair(l)

      if (p) {
        rows.push(p)
      } else {
        notes.push(l.trim())
      }
    }

    return rows.length ? { kind: 'credits', notes, rows, title: name } : text(name, inline, lines)
  }

  return text(name, inline, lines)
}

function text(title: string, inline: string, lines: string[]): UsageSection {
  return { kind: 'text', text: [inline, ...lines].filter(Boolean).join('\n'), title }
}

/** The sections of a `/usage` answer, or null when none of them is a known one. */
export function parseUsage(raw: string): UsageSection[] | null {
  const sections: UsageSection[] = []
  let head: { title: string; inline: string; body: string[] } | undefined
  const preamble: string[] = []

  const flush = () => {
    if (head) {
      sections.push(build(head.title, head.inline, head.body))
    }
  }

  for (const line of raw.replace(/\r/g, '').split('\n')) {
    const h = HEADER.exec(line)

    if (h) {
      flush()
      head = { body: [], inline: (h.groups?.['inline'] ?? '').trim(), title: h.groups?.['title'] ?? '' }
    } else if (head) {
      head.body.push(line)
    } else if (line.trim()) {
      preamble.push(line)
    }
  }

  flush()

  if (!sections.some(s => s.kind !== 'text')) {
    return null
  }

  return preamble.length ? [{ kind: 'text', text: preamble.join('\n'), title: '' }, ...sections] : sections
}
