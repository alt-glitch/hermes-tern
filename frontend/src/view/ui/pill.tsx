// A pill: a clickable chip the keyboard can hold (Down from an empty prompt), as omp's HUD draws
// its agents, shells and PR pills above the composer.

import type { Children, JSX, NodeJson } from '@stencil-hq/tern'

/** One pill. */
export interface PillProps {
  key: string
  /** The pill holds the keyboard: Tern marks it as picked. */
  focused: boolean
  onClick(): void
  title: string
  /** A card Tern shows while the pointer rests on the pill. */
  hovercard?: NodeJson | undefined
  /** The pill's role; omp's `omp.hud.pill` by default. */
  role?: string
  /**
   * Where the content sits: in a part of this role, omp's padded, hoverable `omp.hud.seg` by
   * default; `false` puts it in the pill itself, spaced `xs` (the automation line's items).
   */
  seg?: string | false
  children: Children
}

/** A pill and its content. */
export function pill(p: PillProps): JSX.Element {
  const seg = p.seg ?? 'omp.hud.seg'

  return (
    <row
      align="center"
      key={p.key}
      {...(seg === false ? { gap: 'xs' } : {})}
      {...(p.focused ? { mark: 'pick' } : {})}
      onClick={p.onClick}
      role={p.role ?? 'omp.hud.pill'}
      title={p.title}
      {...(p.hovercard ? { hovercard: p.hovercard } : {})}
    >
      {seg === false ? (
        p.children
      ) : (
        <row align="center" gap="xs" key="seg" role={seg}>
          {p.children}
        </row>
      )}
    </row>
  )
}
