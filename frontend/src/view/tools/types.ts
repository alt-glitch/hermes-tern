// The shape every tool card family returns, and the shell (shell.tsx) turns into a `tool` node.

import type { JSX } from '@stencil-hq/tern'

/** How one call presents: omp's tool props (minus status and timing) and its body. */
export interface Card {
  name: string
  title: string
  target?: string
  targetKind?: 'command' | 'path' | 'pattern' | 'query' | 'text'
  role?: string
  lang?: string
  meta?: string[]
  badges?: { text: string; tone?: string }[]
  /** `inline` drops the frame and keeps the head line (omp's read, grep, glob). */
  frame?: 'inline'
  /** Folded once settled. */
  folded?: boolean
  preview?: { lines: number } | { tail: number }
  /** Overrides the derived status (a task stays running while its agents work). */
  status?: 'running'
  /** Overrides the call's own duration (a background task lasts until its agents finish). */
  took?: number
  body: JSX.Element[]
}
