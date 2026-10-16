// Ages for Tern-clocked timers (`elapsed`, a tool's `age`). Tern stores
// `start = receive time - age`, so a node keeps the age it was first sent
// with: resending a fresh age every frame would be a needless `set`.

const kAge = Symbol('tsp.age')

/** A model object carrying the age its timer was first sent with. */
interface Aged {
  [kAge]?: number
}

/** The age to send for a timer that started at `startedAt`, fixed at first use on `owner`. */
export function age(owner: object, startedAt: number, now: number): number {
  const aged: Aged = owner

  return (aged[kAge] ??= Math.max(0, now - startedAt))
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

/** `1.2K`, `34K`, `1.1M`. */
export function compact(n: number): string {
  if (n < 1000) {
    return String(n)
  }

  if (n < 1_000_000) {
    const k = n / 1000

    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}K`
  }

  const m = n / 1_000_000

  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)}M`
}
