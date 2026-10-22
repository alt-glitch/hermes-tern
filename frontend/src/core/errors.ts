// Errors as the user reads them.

/** What went wrong, for a notice: an Error's message, anything else thrown as text. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A Node system error's code (`ENOENT`, `EACCES`, `EEXIST`, …); undefined for any other throw. */
export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/** A gateway refusal's JSON-RPC error code (`4004`, …); undefined for any other throw. */
export function rpcErrorCode(error: unknown): number | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'number' ? error.code : undefined
}
