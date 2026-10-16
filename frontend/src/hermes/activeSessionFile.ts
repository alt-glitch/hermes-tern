import { writeFileSync } from 'node:fs'

/**
 * Records the live session's stored id where the `hermes` launcher reads it
 * after the frontend exits (`HERMES_TUI_ACTIVE_SESSION_FILE`), for the
 * "resume with …" epilogue. Shared by the Ink TUI and the Tern frontend.
 */
export const writeActiveSessionFile = (sessionId: null | string, file = process.env.HERMES_TUI_ACTIVE_SESSION_FILE) => {
  if (!file || !sessionId) {
    return
  }

  try {
    writeFileSync(file, JSON.stringify({ session_id: sessionId }), { mode: 0o600 })
  } catch {
    // Best-effort shell epilogue hint only; never break live session changes.
  }
}
