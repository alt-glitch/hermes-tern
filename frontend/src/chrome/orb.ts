// The orb is Kevin's thinking-orbs library (github.com/kvnloo/thinking-orbs): its portable engine
// computes each frame's z-sorted, depth-shaded dots and this file only writes them out as SVG, the
// way the library's canvas painter fills them. Agent state comes from Hermes events. Only the image
// animates, never the transcript.
import type { ImageProps, Session, Surface } from '@stencil-hq/tern'
import { MODE_FRAMES, type OrbState as LibraryState, resolvePreset } from 'thinking-orbs/engine'
import type { AnyGatewayEvent } from '@tui/gatewayTypes.js'

export type OrbState = 'idle' | 'working' | 'thinking' | 'composing' | 'listening' | 'speaking' | 'waiting' | 'error'

/** Presentation of the owning agent, not an estimate of progress. */
export class OrbActivity {
  #phase: OrbState = 'idle'
  #voice: OrbState = 'idle'
  #active = false
  readonly #tools = new Set<string>()

  reset(running = false) {
    this.#phase = running ? 'working' : 'idle'
    this.#active = running
    this.#voice = 'idle'
    this.#tools.clear()
  }

  state(waiting = false): OrbState {
    if (waiting) {
      return 'waiting'
    }

    if (this.#phase === 'error' || this.#voice === 'error') {
      return 'error'
    }

    if (this.#voice === 'listening' || this.#voice === 'speaking') {
      return this.#voice
    }

    if (this.#tools.size) {
      return 'working'
    }

    // App-side shell expansion and prompt admission are not confirmed agent activity.
    return this.#phase === 'idle' ? this.#voice : this.#phase
  }

  event(ev: AnyGatewayEvent) {
    if (
      !this.#active &&
      (ev.type === 'reasoning.delta' ||
        ev.type === 'reasoning.available' ||
        ev.type === 'thinking.delta' ||
        ev.type === 'message.delta' ||
        ev.type === 'message.interim' ||
        ev.type === 'tool.generating' ||
        ev.type === 'tool.start')
    ) {
      return
    }

    switch (ev.type) {
      case 'message.start':
        this.#active = true
        this.#phase = 'working'
        this.#tools.clear()

        break

      case 'reasoning.delta':

      case 'reasoning.available':

      case 'thinking.delta':
        this.#phase = 'thinking'

        break

      case 'message.delta':

      case 'message.interim':
        this.#phase = 'composing'

        break

      case 'tool.generating':
        this.#phase = 'working'

        break

      case 'tool.start':
        if (ev.payload) {
          this.#tools.add(ev.payload.tool_id)
        }

        this.#phase = 'working'

        break

      case 'tool.complete':
        if (ev.payload) {
          this.#tools.delete(ev.payload.tool_id)
        }

        break

      case 'message.complete':
        this.#active = false
        this.#phase = ev.payload?.status === 'error' ? 'error' : 'idle'
        this.#tools.clear()

        break

      case 'error':

      case 'gateway.start_timeout':

      case 'gateway.protocol_error':
        this.#active = false
        this.#phase = 'error'
        this.#tools.clear()

        break
      case 'voice.status': {
        const phase = ev.payload?.state
        this.#voice =
          phase === 'listening' || phase === 'recording' || phase === 'captured'
            ? 'listening'
            : phase === 'speaking' || phase === 'playing' || phase === 'tts'
              ? 'speaking'
              : phase === 'transcribing'
                ? 'thinking'
                : phase === 'error'
                  ? 'error'
                  : 'idle'

        break
      }

      default:
        // This is a partial event projector: unrelated gateway events never change the orb.
        return
    }
  }
}

const NODE_ID = 'dock.composer.line.orb'
const FPS = 15
// 9.6 s of frames, then the cached cycle repeats: bounded blobs per state and theme.
const FRAMES = 144

/** Finite cached SVG frames; no new blobs after a state's first animation cycle. */
export class ThinkingOrb {
  readonly #tern: Session
  readonly #surface: Surface
  readonly #frames = new Map<string, string>()
  #state: OrbState = 'idle'
  #frame = 0
  #dark: boolean
  #reduce: boolean
  #visible = true
  #paused = false
  #closed = false
  #timer: NodeJS.Timeout | undefined

  constructor(tern: Session, surface: Surface) {
    this.#tern = tern
    this.#surface = surface
    this.#dark = Boolean(tern.caps.dark)
    this.#reduce = Boolean(tern.caps.reduceMotion)
  }

  update(state: OrbState, paused = false) {
    if (this.#closed) {
      return
    }

    if (state !== this.#state) {
      this.#state = state
      this.#frame = 0
    }

    this.#paused = paused
    this.#sync()
  }

  environment(options: { dark?: boolean; reduce?: boolean; visible?: boolean }) {
    if (this.#closed) {
      return
    }

    this.#dark = options.dark ?? this.#dark
    this.#reduce = options.reduce ?? this.#reduce
    this.#visible = options.visible ?? this.#visible

    if (this.#reduce) {
      this.#frame = 0
    }

    this.#sync()
  }

  props(): ImageProps {
    return { blob: this.#blob(), alt: `Hermes agent: ${this.#state}`, w: 34, h: 34 }
  }

  close() {
    this.#closed = true
    this.#stop()
  }

  #stop() {
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  #sync() {
    const run =
      this.#visible &&
      !this.#reduce &&
      !this.#paused &&
      this.#state !== 'idle' &&
      this.#state !== 'waiting' &&
      this.#state !== 'error' &&
      !this.#surface.closed

    if (!run) {
      this.#stop()
    } else if (!this.#timer) {
      this.#timer = setInterval(() => {
        if (this.#surface.closed) {
          this.#stop()

          return
        }

        // Skip blocked frames rather than growing the SDK's raw-op queue.
        if (this.#surface.blocked) {
          return
        }

        this.#frame = (this.#frame + 1) % FRAMES
        this.#surface.send([['set', NODE_ID, { blob: this.#blob() }]])
      }, 1000 / FPS)
      this.#timer.unref()
    }
  }

  #blob(): string {
    const key = `${this.#dark}:${this.#state}:${this.#frame}`
    let blob = this.#frames.get(key)

    if (!blob) {
      blob = this.#tern.blob(
        Buffer.from(orbSvg(this.#state, this.#frame / FPS, this.#dark)),
        'image/svg+xml'
      )
      this.#frames.set(key, blob)
    }

    return blob
  }
}

/** Which of the library's nine animations shows each agent state. */
export const LIBRARY_STATE: Readonly<Record<OrbState, LibraryState>> = {
  working: 'working', // particles on tilted orbits: tools running
  thinking: 'solving', // bands scramble and click back: reasoning
  composing: 'composing', // an undulating multi-band sash: writing the answer
  listening: 'listening', // a waveform rolling through the rings
  speaking: 'listening',
  waiting: 'breathing', // a ring slowly morphing, held still until the user answers
  idle: 'breathing',
  error: 'breathing'
}

// The library's avatar-scale tuning (its 64px preset), shown at the composer's 34px image size.
const SOURCE = 64
// Still states and reduced motion draw the library's own static frame (ThinkingOrb's frame(0.6)).
const STILL = 0.6

/** One frame of the library orb as SVG; `seconds` is elapsed animation time for animated states. */
export function orbSvg(state: OrbState, seconds: number, dark: boolean): string {
  const preset = resolvePreset(LIBRARY_STATE[state], SOURCE)
  const animated = state !== 'idle' && state !== 'waiting' && state !== 'error'
  const frame = MODE_FRAMES[preset.mode](SOURCE, animated ? seconds * preset.speed : STILL, preset.opts)

  // The library's ink: 0 is darkest on paper and dark themes mirror it (paint/paintLines in its core).
  const grey = (white: number) => {
    const ink = Math.min(1, Math.max(0, white))
    const level = Math.round((dark ? 1 - ink : ink) * 255)

    return `#${level.toString(16).padStart(2, '0').repeat(3)}`
  }

  // Tenths of a viewBox unit are finer than the 2x image's pixels; shorter frames keep blobs small.
  const n = (v: number) => v.toFixed(1)
  const alpha = (v: number | undefined) => (v ?? 1).toFixed(2)

  const marks = frame.lines.map(
    l =>
      `<line x1="${n(l.x1)}" y1="${n(l.y1)}" x2="${n(l.x2)}" y2="${n(l.y2)}" stroke="${grey(l.white)}" stroke-width="${n(l.w)}" stroke-opacity="${alpha(l.a)}"/>`
  )

  for (const d of frame.dots) {
    marks.push(`<circle cx="${n(d.x)}" cy="${n(d.y)}" r="${n(d.r)}" fill="${grey(d.white)}" fill-opacity="${alpha(d.a)}"/>`)
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="68" height="68" viewBox="0 0 ${SOURCE} ${SOURCE}">${marks.join('')}</svg>`
}
