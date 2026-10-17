import { spawn } from 'node:child_process'

/**
 * Copies `text` as omp does: OSC 52 to the terminal (which reaches the Mac's
 * clipboard over ssh too) and, on a local Mac, `pbcopy` as well.
 */
export function copyToClipboard(text: string, env: NodeJS.ProcessEnv = process.env) {
  process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`)

  if (process.platform === 'darwin' && !env.SSH_CONNECTION && !env.SSH_TTY) {
    const child = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] })
    // OSC 52 already went out; a missing pbcopy only loses the second path.
    child.on('error', () => {})
    child.stdin.end(text)
  }
}
