// JSON as it arrives from the gateway, the disk and stored transcripts: untyped until read.

/** A JSON object, parsing JSON text (stored tool results are strings). */
export function record(v: unknown): Record<string, unknown> | undefined {
  if (typeof v === 'string') {
    try {
      return record(JSON.parse(v))
    } catch {
      return undefined
    }
  }

  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/** The value JSON text holds, unread; undefined when the text is not JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The value JSON text holds, unread; throws a SyntaxError when the text is not JSON (parseJson falls back instead). */
export function decodeJson(text: string): unknown {
  return JSON.parse(text)
}

/** A plugin command's JSON reply standing in for a gateway method's: its `error` thrown, the rest the reply. */
export function commandReply<T>(output: string): T {
  const reply = record(output)
  if (!reply) throw new Error('the command did not answer with JSON')
  if (typeof reply.error === 'string') throw new Error(reply.error)
  return reply as T
}
