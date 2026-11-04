import type { JSX } from '@stencil-hq/tern'

import type { ComposerImage } from '../draft/attachments.js'

import { pressable } from './ui/button.js'

/**
 * An attached image as omp's composer chip (a card Tern lays out as a 36px thumbnail beside the
 * name and its size), as t3code's composer shows one: a click on the thumbnail opens it large in
 * Tern's lightbox; the ✕ drops it (`onRemove` gets the chip's index).
 */
export function imageChip(a: ComposerImage, i: number, onRemove: (index: number) => void): JSX.Element {
  return (
    <card head={[{ s: 'strong', t: a.label }]} key={`a${i}`} role="omp.composer.chip" title={a.label} tone="accent">
      {a.image ? <image alt={a.label} key="thumb" {...a.image} /> : <icon key="thumb" name="image" />}
      <text
        key="caption"
        spans={[a.pending ? { fx: 'shimmer', s: 'dim', t: 'Attaching…' } : { s: 'dim', t: a.caption ?? 'image' }]}
        wrap="none"
      />
      {pressable(
        { key: 'remove', name: `Remove ${a.label}`, onClick: () => onRemove(i), role: 'hermes.composer.remove' },
        <icon key="face" name="x" title={`Remove ${a.label}`} />
      )}
    </card>
  )
}
