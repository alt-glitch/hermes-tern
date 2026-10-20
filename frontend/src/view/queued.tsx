// The dock's queued prompts: one row per prompt waiting behind the turn, oldest first, with the
// Edit and Steer this pane can do on it (turn/queue.ts builds the rows).

import type { JSX } from '@stencil-hq/tern'

import { assertNever } from '../core/assert.js'
import type { QueuedRow } from '../turn/queue.js'

import { pressable } from './ui/button.js'

/** What a queued row's buttons do, by its index: Edit pulls it into the composer; Steer (absent when no turn runs) sends it into the turn. */
export interface QueuedActions {
  edit(index: number): void
  steer?: ((index: number) => void) | undefined
}

/** The queued prompts' column (`omp.queue`); the first row carries the count and the shortcuts. */
export function queuedNode(queued: readonly QueuedRow[], on: QueuedActions): JSX.Element {
  return (
    <col gap="xs" key="queue" role="omp.queue">
      {queued.map((q, i) => (
        <row align="center" gap="sm" key={`q${i}`} role="omp.queue.item" title={queuedTitle(q)}>
          <icon key="icon" name={q.kind === 'sending' ? 'clock' : 'corner-down-right'} />
          <text grow={1} key="text" text={q.text.replace(/\s*\r?\n\s*/g, ' ↵ ')} truncate="end" wrap="none" />
          {i === 0 && queued.length > 1 ? <badge key="count" role="omp.queue.count" text={`${queued.length}`} /> : null}
          {q.kind === 'foreign' && q.note === 'unknown' ? <badge key="note" text="unknown" tone="warning" /> : null}
          {on.steer && editable(q) && q.steer
            ? pressable(
                { key: 'steer', name: 'Steer', onClick: () => on.steer?.(i) },
                <row align="center" gap="xs" key="face" role="omp.queue.steer" title={`Steer the running turn with this instead${i === 0 ? '  ⌥↵' : ''}`}>
                  <icon key="i" name="corner-up-right" />
                  {i === 0 ? <kbd key="k" keys={['alt', 'enter']} /> : null}
                  <text key="t" text="Steer" />
                </row>
              )
            : null}
          {editable(q)
            ? pressable(
                { key: 'edit', name: 'Edit', onClick: () => on.edit(i) },
                <row align="center" gap="xs" key="face" role="omp.queue.edit" title={`Edit in the composer${i === 0 ? '  ⌥↑' : ''}`}>
                  {i === 0 ? <kbd key="k" keys={['alt', 'up']} /> : null}
                  <text key="t" text="Edit" />
                </row>
              )
            : null}
        </row>
      ))}
    </col>
  )
}

/** A queued row's hover title: whose it is, and why it cannot be acted on. */
function queuedTitle(q: QueuedRow): string {
  switch (q.kind) {
    case 'local':

    case 'mine':
      return 'Queued'

    case 'sending':
      return 'Queuing…'

    case 'foreign':
      return q.note === 'elsewhere' ? 'Queued by another window (or before a reconnect)' : 'Queued behind a turn whose outcome is unknown'

    default:
      return assertNever(q, 'queued row')
  }
}

/** A row this pane can act on: Edit takes it back into the composer, and Steer may send it into the turn. */
function editable(q: QueuedRow): q is Extract<QueuedRow, { steer: boolean }> {
  return q.kind === 'local' || q.kind === 'mine'
}
