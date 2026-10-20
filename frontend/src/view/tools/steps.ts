// What the tool views' step lines share (the one-line steps of a work group, view/workLog.tsx):
// a path as the user reads it, and the line of a tool with no words of its own.

import { homedir } from 'node:os'

import { launchEnv } from '../../config/env.js'
import type { ToolCall } from '../../model.js'
import { flat, relativePath } from '../format.js'

/** A path as the user reads it: under the working folder relative, under home with `~`. */
export function shortPath(path: string): string {
  return relativePath(path, { cwd: launchEnv().cwd, home: homedir() })
}

/** A tool's name in words ("Session search"), then the gateway's line for the call, if it has one. */
export function namedStep(call: Pick<ToolCall, 'context' | 'name'>): string {
  const name = call.name.replace(/_/g, ' ')
  const label = name.charAt(0).toUpperCase() + name.slice(1)

  return call.context ? `${label}: ${flat(call.context)}` : label
}
