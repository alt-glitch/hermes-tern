// The log files a background command writes its output to. A third of Hermes' background jobs
// send it to a file (`cmd > /tmp/x.log 2>&1`, `cmd | tee run.log`), which leaves the process's own
// output empty; their charts read the file instead, as a second source beside `out`.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import type { TextChunk, TextSource } from './runtime.js'

/** `> path`, `>> path`, `1> path`, `&> path`, and `tee [-a] path`; not `2>` (errors) or `>&1`. */
const TARGET = /(?:^|[\s;&|(])(?:1|&)?>>?\s*([^\s;&|)<>]+)|\btee\s+(?:-a\s+)?([^\s;&|)<>-][^\s;&|)<>]*)/g
/** A leading `cd DIR &&`: where relative paths start. */
const CD = /^\s*cd\s+([^\s;&|]+)\s*(?:&&|;)/
/** Files that are not output. */
const SKIP = /^\/dev\/|^&/

const unquote = (s: string) => s.replace(/^(['"])(.*)\1$/, '$2')

/** `$HOME`, `${TMPDIR}` and `~` expanded from `env`; undefined when another variable is left. */
function expand(path: string, env: NodeJS.ProcessEnv): string | undefined {
  const out = unquote(path)
    .replace(/^~(?=\/|$)/, env['HOME'] || homedir())
    .replace(/\$\{?(HOME|TMPDIR|USER)\}?/g, (_, name: string) => env[name]?.replace(/\/$/, '') ?? `$${name}`)

  return out.includes('$') ? undefined : out
}

/** The files `command` sends its output to, as absolute paths, in the order it names them. */
export function outputFiles(command: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const cd = CD.exec(command)?.[1]
  const base = cd ? expand(cd, env) : undefined
  const files: string[] = []

  for (const m of command.matchAll(TARGET)) {
    const raw = m[1] ?? m[2]

    if (!raw || SKIP.test(raw)) {
      continue
    }

    const path = expand(raw, env)
    const full = path && (isAbsolute(path) ? path : base && isAbsolute(base) ? join(base, path) : undefined)

    if (full && !files.includes(normalize(full))) {
      files.push(normalize(full))
    }
  }

  return files
}

/** Characters a {@link FileTap} keeps, and how much of an existing file its first read takes. */
const CAPACITY = 256 * 1024

/**
 * A log file as a source, read from where the last read stopped. A file that shrinks (rewritten
 * or truncated) reads again from its start, after a gap; a file that does not exist yet reads as
 * nothing until it does.
 */
export class FileTap implements TextSource {
  #text = ''
  #start = 0
  /** Bytes of the file read so far. */
  #offset = 0
  #open = true
  /** Keeps a character split between two reads whole. */
  #decoder = new StringDecoder('utf8')

  constructor(
    readonly id: string,
    readonly path: string
  ) {}

  get label(): string {
    return `the file ${this.path}`
  }

  /** Reads what the file gained since the last call. */
  update() {
    if (!this.#open) {
      return
    }

    let fd: number | undefined

    try {
      fd = openSync(this.path, 'r')
      const size = fstatSync(fd).size

      if (size < this.#offset) {
        // Rewritten: what follows is a new text, after a gap.
        this.#start += this.#text.length + 1
        this.#text = ''
        this.#offset = 0
        this.#decoder = new StringDecoder('utf8')
      }

      // A large file already there: its newest part only, after a gap.
      if (this.#offset === 0 && size > CAPACITY) {
        this.#start += this.#text.length + 1
        this.#offset = size - CAPACITY
      }

      const length = Math.min(size - this.#offset, 4 * CAPACITY)

      if (length > 0) {
        const buf = Buffer.alloc(length)
        const read = readSync(fd, buf, 0, length, this.#offset)
        this.#offset += read
        this.#append(this.#decoder.write(buf.subarray(0, read)))
      }
    } catch {
      // Not there (yet), or not readable: nothing new.
    } finally {
      if (fd !== undefined) {
        closeSync(fd)
      }
    }
  }

  close() {
    this.#open = false
  }

  read(from: number): TextChunk {
    const end = this.#start + this.#text.length
    const start = Math.min(Math.max(from, this.#start), end)

    return { end, open: this.#open, start, text: this.#text.slice(start - this.#start) }
  }

  #append(text: string) {
    this.#text += text
    const excess = this.#text.length - CAPACITY

    if (excess > CAPACITY / 4) {
      this.#text = this.#text.slice(excess)
      this.#start += excess
    }
  }
}
