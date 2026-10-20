// A failure as a value, for boundary code that must tell a failure apart from an empty answer: a
// file that is not there yet is not a file this process may not read.

/** What a call that can fail gave: its value, or what it threw. */
export type Result<T, E = unknown> = { kind: 'ok'; value: T } | { kind: 'failed'; error: E }

/** `fn()`'s value, or what it threw. */
export function attempt<T>(fn: () => T): Result<T> {
  try {
    return { kind: 'ok', value: fn() }
  } catch (error) {
    return { error, kind: 'failed' }
  }
}

/** What `promise` resolved to, or what it rejected with. */
export async function settle<T>(promise: Promise<T>): Promise<Result<T>> {
  try {
    return { kind: 'ok', value: await promise }
  } catch (error) {
    return { error, kind: 'failed' }
  }
}
