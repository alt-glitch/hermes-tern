// Which gateway events this pane leaves alone, and a compile-time check that the handlers and
// this list cover every event type the contract declares, with no type in both. A Hermes bump
// that adds an event type fails typecheck here until it is handled or named below.

import type { EventName, Handled } from './dispatch.js'

/** The declared event types the pane ignores: other frontends' features, or nothing to show. */
export const IGNORED = [
  'agent.print',
  'billing.step_up.verification',
  'bot_relay.outbox.pending',
  'browser.controller.cancel',
  'browser.controller.command',
  'browser.progress',
  'cron.changed',
  'dashboard.new_session_requested',
  'display.install.done',
  'display.install.log',
  'display.lease',
  'display.status',
  'free_tier.challenge',
  'gateway.stderr',
  'message.reaction',
  'onboarding.ended',
  'pairing.changed',
  'pane.reveal',
  'pet.changed',
  'pet.generate.progress',
  'pet.hatch.progress',
  'platforms.changed',
  'preview.close',
  'preview.open',
  'preview.restart.complete',
  'preview.restart.progress',
  'projects.changed',
  'reaction',
  'session.reclaimed',
  'session.resume_progress',
  'setup.ready',
  'skills.changed',
  'terminal.close',
  'tip.show',
  'tool.output_risk',
  'voice.interrupted',
  'voice.partial',
  'voice.status',
  'voice.transcript',
  'wake.detected'
] as const satisfies readonly EventName[]

/** Takes only `never`: a type argument that names an event fails to compile, naming it. */
type None<T extends never> = T

/**
 * The totality check, type-only: the first entry names each declared event type neither handled
 * nor ignored, the second each ignored type a handler takes after all. Both must be empty.
 */
export type Coverage = [None<Exclude<EventName, Handled | (typeof IGNORED)[number]>>, None<Extract<(typeof IGNORED)[number], Handled>>]
