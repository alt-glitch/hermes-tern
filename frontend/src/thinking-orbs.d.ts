// Types for the part of thinking-orbs this frontend uses (its portable engine). The package's own
// declarations import siblings without file extensions, which `nodenext` resolution cannot follow,
// so every engine type would read as `any`. These mirror dist/engine/*.d.ts at the pinned commit.
declare module 'thinking-orbs/engine' {
  export type OrbState =
    | 'working'
    | 'searching'
    | 'solving'
    | 'listening'
    | 'connecting'
    | 'weaving'
    | 'composing'
    | 'breathing'
    | 'shaping'

  export type OrbSize = 64 | 20

  export type ModeKey = 'orbits' | 'globe' | 'rubik' | 'wave' | 'web' | 'braid' | 'ribbon' | 'ring' | 'morph'

  /** Opaque, fully scaled mode options: produced by resolvePreset, consumed by MODE_FRAMES. */
  export interface ModeOpts {
    readonly [option: string]: number | boolean | undefined
  }

  export interface Dot {
    x: number
    y: number
    z: number
    r: number
    /** Ink value: 0 = darkest ink on paper. Mirrored on dark themes. */
    white: number
    a?: number
  }

  export interface Line {
    x1: number
    y1: number
    x2: number
    y2: number
    white: number
    a?: number
    w: number
  }

  /** Already z-sorted, radius-clamped draw instructions: lines first, then dots in order. */
  export interface OrbFrame {
    dots: Dot[]
    lines: Line[]
  }

  export type ModeFrame = (size: number, t: number, opts: ModeOpts) => OrbFrame

  export interface Resolved {
    mode: ModeKey
    speed: number
    opts: ModeOpts
  }

  export const MODE_FRAMES: Readonly<Record<ModeKey, ModeFrame>>
  export function resolvePreset(state: OrbState, size: OrbSize): Resolved
}
