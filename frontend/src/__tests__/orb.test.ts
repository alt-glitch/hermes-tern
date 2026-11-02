import type { Session, Surface } from '@stencil-hq/tern'
import type { AnyGatewayEvent } from '@tui/gatewayTypes.js'
import { describe, expect, it, vi } from 'vitest'

import { OrbActivity, ThinkingOrb } from '../chrome/orb.js'

import { stub } from './fakes.js'

const event = (type: string, payload: object = {}) => stub<AnyGatewayEvent>({ type, payload })

describe('agent orb lifecycle', () => {
  it('keeps active tools visible through concurrent reasoning and response chunks', () => {
    const activity = new OrbActivity()
    activity.event(event('message.start'))
    activity.event(event('tool.start', { tool_id: 'a' }))
    activity.event(event('tool.start', { tool_id: 'b' }))
    activity.event(event('reasoning.delta', { text: 'reason' }))
    activity.event(event('tool.complete', { tool_id: 'a' }))
    expect(activity.state()).toBe('working')
    activity.event(event('message.delta', { text: 'response' }))
    activity.event(event('tool.complete', { tool_id: 'b' }))
    expect(activity.state()).toBe('composing')
    expect(activity.state(true)).toBe('waiting')
    activity.event(event('message.complete', { status: 'completed' }))
    expect(activity.state()).toBe('idle')
  })

  it('shows failure and clears the previous session state on adoption', () => {
    const activity = new OrbActivity()
    activity.event(event('message.start'))
    activity.event(event('reasoning.delta', { text: 'reason' }))
    expect(activity.state()).toBe('thinking')
    activity.event(event('message.complete', { status: 'error' }))
    expect(activity.state()).toBe('error')
    activity.reset(true)
    expect(activity.state()).toBe('working')
    activity.reset()
    expect(activity.state()).toBe('idle')
  })

  it('does not revive terminal activity from late same-session events', () => {
    const activity = new OrbActivity()
    activity.event(event('message.start'))
    activity.event(event('message.complete', { status: 'complete' }))
    activity.event(event('reasoning.available', { text: 'late reasoning' }))
    activity.event(event('tool.start', { tool_id: 'late' }))
    expect(activity.state()).toBe('idle')
    activity.event(event('message.start'))
    activity.event(event('gateway.protocol_error'))
    activity.event(event('message.delta', { text: 'late response' }))
    expect(activity.state()).toBe('error')
    activity.event(event('message.start'))
    expect(activity.state()).toBe('working')
  })

  it('does not mistake app-side busy work for an agent turn; resumes only confirmed work', () => {
    const activity = new OrbActivity()
    expect(activity.state()).toBe('idle')
    activity.event(event('message.delta', { text: 'late reply before start' }))
    expect(activity.state()).toBe('idle')
    activity.event(event('message.start'))
    activity.event(event('message.delta', { text: 'reply' }))
    expect(activity.state()).toBe('composing')
    activity.reset(true)
    expect(activity.state()).toBe('working')
    activity.reset()
    expect(activity.state()).toBe('idle')
  })

  it('uses voice events without treating an idle composer as microphone capture', () => {
    const activity = new OrbActivity()
    expect(activity.state()).toBe('idle')
    activity.event(event('voice.status', { state: 'listening' }))
    expect(activity.state()).toBe('listening')
    activity.event(event('voice.status', { state: 'transcribing' }))
    expect(activity.state()).toBe('thinking')
    activity.event(event('voice.status', { state: 'speaking' }))
    expect(activity.state()).toBe('speaking')
    activity.event(event('voice.status', { state: 'idle' }))
    expect(activity.state()).toBe('idle')
  })
})

describe('orb animation boundaries', () => {
  it('does not enqueue animation while blocked, hidden, reduced-motion, paused or closed', () => {
    vi.useFakeTimers()
    const send = vi.fn<Surface['send']>()
    const blob = vi.fn((bytes: Uint8Array) => Buffer.from(bytes).toString('base64'))
    const surface = { send, blocked: false, closed: false }

    const orb = new ThinkingOrb(
      stub<Session>({ blob, caps: { dark: true, reduceMotion: false } }),
      stub<Surface>(surface)
    )

    try {
      orb.update('thinking')
      const first = orb.props().blob
      vi.advanceTimersByTime(200)
      const next = orb.props().blob
      expect(next).not.toBe(first)
      expect(send).toHaveBeenLastCalledWith([['set', 'dock.composer.line.orb', { blob: next }]])
      send.mockClear()
      surface.blocked = true
      vi.advanceTimersByTime(1000)
      expect(send).not.toHaveBeenCalled()
      surface.blocked = false
      orb.environment({ visible: false })
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(1000)
      expect(send).not.toHaveBeenCalled()
      orb.environment({ visible: true, reduce: true })
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(1000)
      expect(send).not.toHaveBeenCalled()
      orb.environment({ reduce: false })
      orb.update('waiting')
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(1000)
      expect(send).not.toHaveBeenCalled()
      orb.update('working', true)
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(1000)
      expect(send).not.toHaveBeenCalled()
      orb.update('working')
      surface.closed = true
      vi.advanceTimersByTime(1000)
      expect(send).not.toHaveBeenCalled()
    } finally {
      orb.close()
      vi.useRealTimers()
    }
  })

  it('reuses a bounded image cycle rather than growing the blob cache indefinitely', () => {
    vi.useFakeTimers()
    const send = vi.fn<Surface['send']>()
    const blob = vi.fn((_bytes: Uint8Array) => `frame-${blob.mock.calls.length}`)

    const orb = new ThinkingOrb(
      stub<Session>({ blob, caps: { dark: true, reduceMotion: false } }),
      stub<Surface>({ send, blocked: false, closed: false })
    )

    try {
      orb.update('composing')
      orb.props()
      vi.advanceTimersByTime(10000)
      const afterCycles = blob.mock.calls.length
      vi.advanceTimersByTime(10000)
      expect(blob.mock.calls.length).toBe(afterCycles)
      orb.update('idle')
      expect(vi.getTimerCount()).toBe(0)
      const idle = orb.props().blob
      vi.advanceTimersByTime(10000)
      expect(orb.props().blob).toBe(idle)
      orb.close()
      send.mockClear()
      orb.update('speaking')
      orb.environment({ visible: true, reduce: false })
      vi.advanceTimersByTime(10000)
      expect(send).not.toHaveBeenCalled()
    } finally {
      orb.close()
      vi.useRealTimers()
    }
  })
})

describe('orb drawing', () => {
  it('draws the thinking-orbs library frame for each agent state, in monochrome ink', async () => {
    const { MODE_FRAMES, resolvePreset } = await import('thinking-orbs/engine')
    const { LIBRARY_STATE, orbSvg } = await import('../chrome/orb.js')

    for (const state of ['working', 'thinking', 'composing', 'listening'] as const) {
      const preset = resolvePreset(LIBRARY_STATE[state], 64)
      const expected = MODE_FRAMES[preset.mode](64, 1.25 * preset.speed, preset.opts)
      const svg = orbSvg(state, 1.25, true)
      const fills = [...svg.matchAll(/fill="#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})"/g)].map(m => m.slice(1))
      expect(fills.length).toBe(expected.dots.length)
      expect(svg.match(/<line /g)?.length ?? 0).toBe(expected.lines.length)
      expect(fills.every(([r, g, b]) => r === g && g === b)).toBe(true)
    }

    expect(LIBRARY_STATE.thinking).toBe('solving')
    expect(orbSvg('working', 1, true)).not.toBe(orbSvg('working', 2, true))
    expect(orbSvg('idle', 1, true)).toBe(orbSvg('idle', 2, true))
    // A dark substrate takes light ink and a light one dark ink, as the library paints them.
    expect(orbSvg('idle', 0, true)).not.toBe(orbSvg('idle', 0, false))
  })
})
