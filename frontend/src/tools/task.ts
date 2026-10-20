// The delegate_task tool's detail: the tasks asked for, and how the agents' run ended.

import { objects, type Raw, records, text } from './fields.js'

/** One task of a delegation: its goal and the brief (`context`) given with it. */
export interface TaskArg {
  goal: string | undefined
  context: string | undefined
}

/** A settled agent's entry in the result's `results`. */
export interface TaskResult {
  status: string | undefined
  summary: string | undefined
  error: string | undefined
}

/** A `delegate_task` call, read once. */
export interface TaskDetail {
  tool: 'delegate_task'
  /** The args' `tasks` that are objects. */
  tasks: TaskArg[]
  /** Each task's brief by its index in the args' `tasks`, holes kept (an agent's `index` points here). */
  briefs: (string | undefined)[]
  /** The single goal and brief of a one-task call. */
  goal: string | undefined
  context: string | undefined
  /** The agents started and run on (`status: 'dispatched'`); the result says no more yet. */
  dispatched: boolean
  /** They run on their own (`mode: 'background'`). */
  background: boolean
  /** The result names an error: the dispatch failed. */
  failed: boolean
  /** Each agent's outcome by index, a hole where an entry is not an object. */
  results: (TaskResult | undefined)[]
}

export function taskDetail({ args, result }: Raw): TaskDetail {
  return {
    background: result?.['mode'] === 'background',
    briefs: records(args['tasks']).map(t => text(t?.['context'])),
    context: text(args['context']),
    dispatched: result?.['status'] === 'dispatched',
    failed: Boolean(result?.['error']),
    goal: text(args['goal']),
    results: records(result?.['results']).map(r => r && { error: text(r['error']), status: text(r['status']), summary: text(r['summary']) }),
    tasks: objects(args['tasks']).map(t => ({ context: text(t['context']), goal: text(t['goal']) })),
    tool: 'delegate_task'
  }
}
