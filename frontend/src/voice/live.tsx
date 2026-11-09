// Explicit per-session live conversation. PR #71 owns review-only dictation.
import { randomUUID } from 'node:crypto'
import type { JSX } from '@stencil-hq/tern'

import { errorText } from '../core/errors.js'

const PHASES = ['idle', 'starting', 'listening', 'transcribing', 'thinking', 'speaking', 'interrupted', 'muted', 'stopping', 'error'] as const
type Phase = (typeof PHASES)[number]
type Control = 'stop' | 'mute' | 'interrupt'

interface Lease {
  id: string
  sid: string
  started: Promise<unknown>
  pending: Promise<void>
  stopping: boolean
  requestedMuted: boolean
}

/** This mode uses the *gateway* audio devices and Hermes STT/TTS, not a second recorder. */
export interface LiveVoiceHost {
  gw: {
    request(method: string, params: Record<string, unknown>): Promise<unknown>
    on(name: 'event' | 'exit', listener: (event: unknown) => void): unknown
    off(name: 'event' | 'exit', listener: (event: unknown) => void): unknown
  }
  talk?: boolean
  sid(): string | null
  switching(): boolean
  changed(): void
}

const asObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isPhase = (v: unknown): v is Phase =>
  typeof v === 'string' && PHASES.some(p => p === v)

export const LIVE_CONSENT = 'Live voice uses the gateway machine microphone and speaker. ' +
  'Spoken utterances are submitted automatically to this Hermes session; replies are spoken ' +
  'through configured Hermes STT/TTS. Your typed draft is never sent or modified by voice. ' +
  'Use Mic / Alt+V (dictation PR #71) to dictate for review instead. ' +
  'Microphone permission and configured providers are required.'

export class LiveVoice {
  phase: Phase | 'consent' = 'idle'
  muted = false
  error = ''
  assistant = ''
  readonly #host: LiveVoiceHost
  #lease: Lease | undefined
  #consentSid: string | null = null
  readonly #onEvent = (ev: unknown) => this.event(ev)
  readonly #onExit = () => this.disconnect()

  constructor(host: LiveVoiceHost) {
    this.#host = host
    host.gw.on('event', this.#onEvent)
    host.gw.on('exit', this.#onExit)
  }

  get blocked(): boolean {
    // Consent blocks draft Send too; a lease stays busy until the gateway confirms idle.
    return this.phase === 'consent' || this.#lease !== undefined
  }

  toggle(): void {
    if (this.#lease) {
      void this.control('stop')
      return
    }
    if (this.phase === 'consent') {
      this.#reset()
      this.#host.changed()
      return
    }
    const sid = this.#host.sid()
    if (!sid || this.#host.switching()) return
    this.error = ''
    this.assistant = ''
    this.phase = 'consent'
    this.#consentSid = sid
    this.#host.changed()
  }

  /** Only the in-pane Allow button calls start; a hotkey only opens consent. */
  start(): void {
    const sid = this.#host.sid()
    if (!sid || sid !== this.#consentSid || this.phase !== 'consent' ||
        this.#lease || this.#host.switching()) return
    const id = randomUUID()
    const started = this.#host.gw.request('voice.live.start', {
      session_id: sid, live_id: id, consent: true
    })
    const lease: Lease = {
      id, sid, started, pending: Promise.resolve(), stopping: false, requestedMuted: false
    }
    this.#lease = lease
    // Retain the owner through errors so a later session switch clears its UI.
    this.phase = 'starting'
    this.muted = false
    this.assistant = ''
    void started.catch((error: unknown) => {
      if (this.#lease === lease) {
        this.#lease = undefined
        this.#fail(error)
      }
    })
    this.#host.changed()
  }

  /** Serialize control behind a possibly pending start, including stop on key cancellation. */
  quickToggle(): void {
    if (this.#lease || this.phase === 'consent') { this.toggle(); return }
    this.toggle()
    this.start()
  }

  async control(action: Control): Promise<void> {
    const lease = this.#lease
    if (!lease) {
      if (action === 'stop' && this.phase === 'consent') {
        this.#reset()
        this.#host.changed()
      }
      return
    }
    if (lease.stopping && action !== 'stop') return
    if (action === 'stop') {
      lease.stopping = true
      this.phase = 'stopping'
      this.#host.changed()
    }
    // Rapid mute/unmute clicks toggle the requested state even before the first ACK.
    const muted = action === 'mute' ? !lease.requestedMuted : lease.requestedMuted
    if (action === 'mute') lease.requestedMuted = muted
    const request = lease.pending.then(async () => {
      await lease.started
      if (this.#lease !== lease || (lease.stopping && action !== 'stop')) return
      await this.#host.gw.request('voice.live.control', {
        session_id: lease.sid, live_id: lease.id, action,
        ...(action === 'mute' ? { muted } : {})
      })
      if (this.#lease === lease && action === 'mute' && !lease.stopping) {
        this.muted = muted
        this.#host.changed()
      }
    })
    lease.pending = request.then(() => undefined, () => undefined)
    try {
      await request
    } catch (error) {
      // Never re-enable draft Send on an uncertain release.
      if (this.#lease === lease) this.#fail(error)
    }
  }

  /** Called as the frontend changes sessions; old audio may not follow a new session. */
  syncOwner(): void {
    const sid = this.#host.sid()
    if (!this.#lease && this.#consentSid &&
        (sid !== this.#consentSid || this.#host.switching())) this.#reset()
    const lease = this.#lease
    if (lease && (sid !== lease.sid || this.#host.switching())) {
      // A prior session's spoken reply must never appear in the next session.
      this.assistant = ''
      this.error = ''
      if (!lease.stopping) void this.control('stop')
    }
  }

  /** Gateway process exit tears down the devices. Consent never survives reconnect. */
  disconnect(): void {
    this.#lease = undefined
    this.#reset()
    this.#host.changed()
  }

  /** Validate both the lease and session before accepting any hint; transcript has its own stream. */
  event(ev: unknown): void {
    if (!asObject(ev) || ev['type'] !== 'voice.live' || !asObject(ev['payload'])) return
    const p = ev['payload']
    const lease = this.#lease
    if (!lease || ev['session_id'] !== lease.sid || p['live_id'] !== lease.id || !isPhase(p['phase'])) return
    if (p['phase'] === 'idle') {
      this.#lease = undefined
      this.phase = this.error ? 'error' : 'idle'
      this.muted = false
      this.assistant = ''
      if (!this.error) this.#consentSid = null
    } else if (!lease.stopping && this.#host.sid() === lease.sid) {
      this.phase = p['phase']
      if (typeof p['muted'] === 'boolean') {
        this.muted = p['muted']
        lease.requestedMuted = p['muted']
      }
      if (typeof p['assistant_text'] === 'string') this.assistant = p['assistant_text']
      if (typeof p['error'] === 'string' && p['error']) this.error = p['error']
    }
    this.#host.changed()
  }

  dispose(): void {
    if (this.#lease) void this.control('stop')
    this.#host.gw.off('event', this.#onEvent)
    this.#host.gw.off('exit', this.#onExit)
  }

  #reset(): void {
    this.phase = 'idle'
    this.#consentSid = null
    this.muted = false
    this.error = ''
    this.assistant = ''
  }

  #fail(reason: unknown): void {
    this.phase = 'error'
    this.error = errorText(reason)
    this.#host.changed()
  }

  /** Inline semantic controls preserve regular tool/approval and transcript rendering. */
  node(): JSX.Element | null {
    const active = this.#lease !== undefined
    // Preserve the existing idle dock, including recorded golden replays.
    // /live and Alt+Shift+V expose this panel on explicit request.
    if (!active && this.phase === 'idle') return null
    return (
      <col key="live-voice" role="omp.live.voice">
        <row key="toggle" role="omp.live.toggle" onClick={() => this.toggle()} title="Live voice · Ctrl+L / Alt+Shift+V">
          <text key="label" text={active ? 'Stop live voice' : 'Live voice…'} />
        </row>
        {this.phase === 'consent' ? (
          <col key="consent" role="omp.live.consent" gap="sm">
            <text key="notice" text={this.#host.talk ? 'Hermes Talk uses this machine’s microphone and speaker with your configured realtime provider. Ctrl+L starts/stops a call; Esc or Stop hangs up. Your typed draft stays unsent.' : LIVE_CONSENT} wrap="word" />
            <row key="allow" role="omp.live.start" onClick={() => this.start()}>
              <text key="text" text="Allow microphone + automatic spoken turns" />
            </row>
            <row key="cancel" role="omp.live.cancel" onClick={() => void this.control('stop')}>
              <text key="text" text="Cancel" />
            </row>
          </col>
        ) : null}
        {active ? (
          <col key="active" role="omp.live.active">
            <text key="phase" role="omp.live.phase" text={'Live voice: ' + this.phase +
              (this.muted ? ' · microphone muted' : '') + ' · draft Send disabled'} />
            <row key="controls" gap="sm">
              {!this.#host.talk ? <row key="legacy-controls" gap="sm">
                <row key="mute" role="omp.live.mute" onClick={() => void this.control('mute')}>
                  <text key="text" text={this.muted ? 'Unmute' : 'Mute'} />
                </row>
                <row key="barge" role="omp.live.interrupt" onClick={() => void this.control('interrupt')}>
                  <text key="text" text="Barge in / silence reply" />
                </row>
              </row> : null}
              <row key="stop" role="omp.live.stop" onClick={() => void this.control('stop')}>
                <text key="text" text="Stop" />
              </row>
            </row>
          </col>
        ) : null}
        {this.assistant ? <text key="assistant" role="omp.live.assistant" text={this.assistant} wrap="word" /> : null}
        {this.error ? <text key="error" role="omp.live.failure" text={this.error +
          (active ? ' · Stop again if release failed' : ' · reopen Live voice to retry')} tone="error" wrap="word" /> : null}
      </col>
    )
  }
}
