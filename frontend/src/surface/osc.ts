// Terminal OSC sequences the pane writes beside the surface protocol: Tern reads them as any
// terminal does, for the tab's name and the pane's folder.

import { hostname } from 'node:os'

/** Where a sequence goes: the pane's stdout. */
type Out = Pick<NodeJS.WriteStream, 'write'>

/**
 * OSC 2: names the pane, and Tern's tab follows it. Control characters become spaces, so a title
 * cannot end the sequence early.
 */
export function setTabTitle(title: string, out: Out = process.stdout) {
  // eslint-disable-next-line no-control-regex -- a title must not end the OSC early
  out.write(`\x1b]2;${title.replace(/[\x00-\x1f]/g, ' ')}\x07`)
}

/**
 * OSC 7: tells Tern the session's folder, so its file viewer, branch and new splits follow a
 * worktree or a moved workspace instead of the folder the pane was opened in.
 */
export function reportCwd(cwd: string, out: Out = process.stdout) {
  out.write(`\x1b]7;file://${hostname()}${encodeURI(cwd)}\x07`)
}
