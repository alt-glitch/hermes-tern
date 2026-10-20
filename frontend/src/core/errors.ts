// Errors as the user reads them.

/** What went wrong, for a notice: an Error's message, anything else thrown as text. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
