// Small parts the sheets share.

import type { OverlayHost } from '../overlay.js'

/**
 * Re-renders every `ms` while a sheet is open, so its clocks and live rows move. The returned
 * function stops it: call it from the sheet's onClose.
 */
export function tickWhileOpen(host: Pick<OverlayHost, 'changed'>, ms: number): () => void {
  const timer = setInterval(() => host.changed(), ms)

  return () => clearInterval(timer)
}
