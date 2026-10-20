// Words and numbers as the views write them: durations, clock times, how long ago, and paths (a
// count with its noun and a cut text are core/text.ts's). Each helper is one format; where two
// views write a thing differently, each way has its own name, so a view picks the one it means.

/** A string with something in it, else undefined: how views read an optional text field. */
export function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/** `text` on one line: each run of whitespace (newlines too) one space, the ends trimmed. */
export function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** `12s`, `3m 05s`, `1h 02m`: a duration as omp's turn footers write it. */
export function duration(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`
  }

  const s = Math.round(ms / 100) / 10

  if (s < 60) {
    return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`
  }

  const m = Math.floor(s / 60)

  if (m < 60) {
    return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`
  }

  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/**
 * `820ms`, `4.3s`, `42s`, `1m 2s`, `1h 2m 5s`: t3code's `formatDuration`
 * (packages/shared/src/orchestrationTiming.ts), the units that are not zero.
 */
export function durationCompact(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '0ms'
  }

  if (ms < 1_000) {
    return `${Math.max(1, Math.round(ms))}ms`
  }

  if (ms < 10_000) {
    const tenths = Math.round(ms / 100) / 10

    return tenths >= 10 ? '10s' : `${tenths.toFixed(1)}s`
  }

  if (ms < 60_000) {
    return `${Math.round(ms / 1_000)}s`
  }

  const total = Math.round(ms / 1_000)
  const h = Math.floor(total / 3_600)
  const m = Math.floor((total % 3_600) / 60)
  const s = total % 60

  return [h ? `${h}h` : '', m ? `${m}m` : '', s ? `${s}s` : ''].filter(Boolean).join(' ')
}

/** `42s`, `3m 5s`, `2h 7m`: whole seconds, the two largest units, as GitHub's checks list writes a run. */
export function durationWhole(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))

  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** `25m`, `2h`, `3d`, `1w`, `2mo`, `1y`: how long, in its largest whole unit (a minute at least), as omp's session list writes an age. */
export function ageShort(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))

  if (m < 60) {
    return `${Math.max(1, m)}m`
  }

  const h = Math.round(m / 60)

  if (h < 24) {
    return `${h}h`
  }

  const d = Math.round(h / 24)

  return d < 7 ? `${d}d` : d < 30 ? `${Math.round(d / 7)}w` : d < 365 ? `${Math.round(d / 30)}mo` : `${Math.round(d / 365)}y`
}

/** `in 12m`, `3h ago`, `now`: how far `iso` is from `now`, in ageShort's units; '' for no time. */
export function relative(iso: string | null | undefined, now: number): string {
  const at = iso ? Date.parse(iso) : NaN

  if (Number.isNaN(at)) {
    return ''
  }

  const d = at - now

  return Math.abs(d) < 45_000 ? 'now' : d > 0 ? `in ${ageShort(d)}` : `${ageShort(-d)} ago`
}

/** `6:15 pm`: a time of day to the minute, in the locale's hour style, lower case. */
export function clockShort(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase()
}

/** `14:02:07`: a wall-clock time today, 24-hour, to the second. */
export function clockSeconds(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', hour12: false, minute: '2-digit', second: '2-digit' })
}

/** `path` with `home` (HOME) as `~`. */
export function homeTilde(path: string, home: string | undefined): string {
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

/** A path as the user reads it: under the working folder `cwd` relative, under `home` with `~`. */
export function relativePath(path: string, o: { cwd: string; home: string }): string {
  const root = o.cwd.replace(/\/+$/, '')

  if (root && path.startsWith(`${root}/`)) {
    return path.slice(root.length + 1)
  }

  return o.home && path.startsWith(`${o.home}/`) ? `~${path.slice(o.home.length)}` : path.replace(/^\.\//, '')
}
