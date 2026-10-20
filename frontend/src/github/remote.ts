// Data a pull request sheet's tab reads from GitHub when the tab shows (the conversation, the
// files): never read, being read, read for one update of the PR, or the last read failed.

/** A tab's data as one read left it: the value, and the PR's `updatedAt` it was read at (a newer PR reads it again). */
export interface Read<T> {
  value: T
  at: string
}

/** A tab's data between reads: never read, read, or the last read failed (keeping what the read before it left). */
export type Settled<T> = { kind: 'idle' } | ({ kind: 'ready' } & Read<T>) | { kind: 'failed'; error: string; failedAt: number; last?: Read<T> | undefined }

/**
 * Data a tab reads from GitHub when it shows: never read, being read, read, or the last read
 * failed. A read in flight keeps the state it left (`was`), so the tab still shows that.
 */
export type Remote<T> = Settled<T> | { kind: 'loading'; was: Settled<T> }

/** What a tab shows of `remote`: the last value read, and why the last read failed. */
export function shown<T>(remote: Remote<T>): { value?: T | undefined; error?: string | undefined } {
  switch (remote.kind) {
    case 'idle':
      return {}

    case 'ready':
      return { value: remote.value }

    case 'failed':
      return { error: remote.error, value: remote.last?.value }

    case 'loading':
      return shown(remote.was)
  }
}

/** The read a failed one keeps showing: what `remote` read last, if anything. */
export const lastRead = <T>(remote: Settled<T>): Read<T> | undefined =>
  remote.kind === 'ready' ? { at: remote.at, value: remote.value } : remote.kind === 'failed' ? remote.last : undefined
