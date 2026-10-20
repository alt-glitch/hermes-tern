// The ids the pane passes around, branded by kind. A brand exists only for the compiler: at run
// time each id is the plain string it was, so no value changes. A branded id reads as a string
// anywhere, but only its constructor here makes one, so a runtime session id cannot go where a
// stored one belongs, nor a tool call's id where an entry's does, without the code saying so.
// Each constructor is called where the value comes in: wire/ for gateway answers, and the event
// and file readers that build the rest.

import { randomUUID } from 'node:crypto'

/** `T`, tagged `B` for the compiler only. */
export type Brand<T, B extends string> = T & { readonly __brand: B }

/** The gateway's runtime id for a session (`session_id` of session.create and session.resume). */
export type LiveSessionId = Brand<string, 'LiveSessionId'>
/** The id a session's history is saved under (state.db `sessions.id`, `stored_session_id`). */
export type StoredSessionId = Brand<string, 'StoredSessionId'>
/** The shared gateway's handle on one view of a session (`subscription_id`). */
export type SubscriptionId = Brand<string, 'SubscriptionId'>
/** The shared gateway's id for a prompt admitted into its FIFO (`admission_id`). */
export type AdmissionId = Brand<string, 'AdmissionId'>
/**
 * The id a prompt is submitted under: this pane sends it as `submission_id`, which the shared
 * gateway's adapter renames `input_id`, and a FIFO row carries it back as `input_id`. One value
 * under two wire names, so one brand.
 */
export type InputId = Brand<string, 'InputId'>
/** The gateway's id for one tool call (`tool_id`). */
export type ToolCallId = Brand<string, 'ToolCallId'>
/** A transcript entry's or block's id, from `Transcript.id()`. */
export type EntryId = Brand<string, 'EntryId'>
/** The process registry's id for a background process (`proc_…`). */
export type ProcessId = Brand<string, 'ProcessId'>
/** The owner's id for a subagent. */
export type SubagentId = Brand<string, 'SubagentId'>
/** The id of the delegation that dispatched subagents. */
export type DelegationId = Brand<string, 'DelegationId'>
/** A linked pull request's key: `host/repository#number`. */
export type PrKey = Brand<string, 'PrKey'>
/** A native GitHub stack's key: `host/repository#stack:number`. */
export type StackKey = Brand<string, 'StackKey'>
/** A connect card's key: the tool call and the operation it watches. */
export type CardKey = Brand<string, 'CardKey'>
/** An overlay's key on the overlay stack. */
export type OverlayKey = Brand<string, 'OverlayKey'>

/** A block's id: a tool block is keyed by its call's id, every other block by an entry id. */
export type BlockKey = EntryId | ToolCallId

/** The id a session is resumed and filed under: its stored id, or its runtime id when no stored id is known. */
export type DurableSessionId = LiveSessionId | StoredSessionId

/** `raw` as a runtime session id. */
export const liveSessionId = (raw: string) => raw as LiveSessionId
/** `raw` as a stored session id. */
export const storedSessionId = (raw: string) => raw as StoredSessionId
/** `raw` as a subscription id. */
export const subscriptionId = (raw: string) => raw as SubscriptionId
/** `raw` as an admission id. */
export const admissionId = (raw: string) => raw as AdmissionId
/** `raw` as a submission's input id. */
export const inputId = (raw: string) => raw as InputId
/** A fresh input id for a prompt this pane submits. */
export const newInputId = () => inputId(randomUUID())
/** `raw` as a tool call id. */
export const toolCallId = (raw: string) => raw as ToolCallId
/** `raw` as an entry id. */
export const entryId = (raw: string) => raw as EntryId
/** `raw` as a background process id. */
export const processId = (raw: string) => raw as ProcessId
/** `raw` as a subagent id. */
export const subagentId = (raw: string) => raw as SubagentId
/** `raw` as a delegation id. */
export const delegationId = (raw: string) => raw as DelegationId
/** The key of pull request `number` in `repository` on `host`. */
export const prKey = (ref: { host: string; repository: string; number: number }) => `${ref.host}/${ref.repository}#${ref.number}` as PrKey
/** The key of native stack `number` in `repository` on `host`. */
export const stackKey = (host: string, repository: string, number: number) => `${host}/${repository}#stack:${number}` as StackKey
/** `raw` as a connect card key. */
export const cardKey = (raw: string) => raw as CardKey
/** `raw` as an overlay key. */
export const overlayKey = (raw: string) => raw as OverlayKey

/**
 * The open session's two ids. `live` is null before the first session and while the gateway is
 * down; `stored` is null until a snapshot names it, and is kept while the gateway is down.
 */
export interface SessionIds {
  readonly live: LiveSessionId | null
  readonly stored: StoredSessionId | null
}

/** An adopted session's ids: the runtime id it answered with, and its stored id when it named one. */
export interface SessionRef extends SessionIds {
  readonly live: LiveSessionId
}

/** Whether `ids` name a runtime session (one the gateway serves now). */
export const isLive = (ids: SessionIds): ids is SessionRef => ids.live !== null

/** No session yet. */
export const NO_SESSION: SessionIds = { live: null, stored: null }

/**
 * The id a session is filed and resumed under (the viewer marker, the launcher's epilogue, its
 * links and stored compactions, a reattach): the stored id, else the runtime id.
 */
export function durable(ref: SessionRef): DurableSessionId
export function durable(ids: SessionIds): DurableSessionId | null
export function durable(ids: SessionIds): DurableSessionId | null {
  return ids.stored ?? ids.live
}
