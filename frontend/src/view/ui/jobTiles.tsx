// The frame and tile chrome shared by background processes and delegated agents.

import type { Children, JSX, SpanData, Tone } from '@stencil-hq/tern'

import { pressable } from './button.js'

/** Tiles in a compact wait frame or hover card before the overflow link. */
export const JOB_TILE_LIMIT = 4

/** One frame, with Tern's OMP grid layout and shared borders. */
export function jobTiles(children: Children, key = 'tiles'): JSX.Element {
  return <row gap="none" key={key} role="omp.job.tiles" wrap>{children}</row>
}

/** A tile's shared status, title and optional trailing metadata, above its body. */
export function jobTile(o: {
  key: string
  title: string
  tone: Tone
  dot: SpanData
  trailing?: Children
  actions?: { click: string; menu?: string[] }
  hint?: string
  children: Children
}): JSX.Element {
  const tile = (
    <col gap="xs" key={o.actions ? 'face' : o.key} role="omp.job.tile" tone={o.tone} {...(o.hint ? { title: o.hint } : {})}>
      <row align="center" gap="xs" key="head" role="omp.job.tile.head">
        <text key="dot" role="omp.job.tile.dot" spans={[o.dot]} wrap="none" />
        <text grow={1} key="title" role="omp.job.tile.title" spans={[{ t: o.title }]} truncate="end" wrap="none" />
        {o.trailing}
      </row>
      {o.children}
    </col>
  )

  // A tile a click opens is a native button (view/ui/button.tsx); the tile keeps omp's role and look.
  return o.actions ? pressable({ action: o.actions.click, key: o.key, menu: o.actions.menu, name: o.hint ?? o.title }, tile) : tile
}
