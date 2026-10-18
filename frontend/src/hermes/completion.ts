// The completion RPC for the text before the caret. Ported from Hermes'
// ui-tui/src/hooks/useCompletion.ts (completionRequestForInput), which reads
// the Ink store for the session; here the caller passes it in.
import { looksLikeSlashCommand } from '@hermes/shared/slash'
import { inlineSlashTrigger } from '@tui/domain/slash.js'

// A path word starts its token: the Ink TUI's pattern lets `@` open mid-word, so `me@host` listed files.
// t3code and Hermes desktop open `@` only at the start of the text or after whitespace.
const TAB_PATH_RE = /(?<=^|\s)((?:["']?(?:[A-Za-z]:[\\/]|\.{1,2}\/|~\/|\/|@|[^"'`\s]+\/))[^\s]*)$/

export interface CompletionScope {
  cwd?: string | null
  sid?: string | null
}

export type CompletionRequest =
  | { method: 'complete.path'; params: { word: string; cwd?: string; session_id?: string }; replaceFrom: number }
  | { method: 'complete.slash'; params: { text: string }; replaceFrom: number; skillsOnly?: boolean }

/** Slash commands (and their arguments), inline `/skill` references, or a path-looking word; null when nothing completes. */
export function completionRequestForInput(input: string, scope: CompletionScope = {}): CompletionRequest | null {
  const isSlashCommand = looksLikeSlashCommand(input)
  const pathWord = isSlashCommand ? null : (input.match(TAB_PATH_RE)?.[1] ?? null)

  // `/model` opens the model picker instead.
  if (isSlashCommand && /^\/model(?:\s|$)/.test(input)) {
    return null
  }

  // Only the first slash can be an invocation: a whitespace-preceded `/token` at the caret is a skill reference.
  const inline = inlineSlashTrigger(input)

  if (inline) {
    return { method: 'complete.slash', params: { text: `/${inline.query}` }, replaceFrom: inline.start + 1, skillsOnly: true }
  }

  if (isSlashCommand) {
    return { method: 'complete.slash', params: { text: input }, replaceFrom: 1 }
  }

  if (!pathWord) {
    return null
  }

  // The shared gateway lists the session's own folder, so it must know which session is asking.
  const { cwd, sid } = scope

  return {
    method: 'complete.path',
    params: { word: pathWord, ...(cwd ? { cwd } : {}), ...(sid ? { session_id: sid } : {}) },
    replaceFrom: input.length - pathWord.length
  }
}
