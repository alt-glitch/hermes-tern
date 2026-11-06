// The dock's inputs for tests: actions that record their calls, a quiet dock context to draw
// from, and the stores dockModel() reads, each as a small typed stand-in that a test overrides.
import { vi } from 'vitest'

import { Composer } from '../draft/composer.js'
import { recordKey } from '../hermes/dictation.js'
import type { DockActions, DockContext } from '../view/dock.js'
import type { DockSources } from '../view/dockModel.js'

/** Every dock action as a mock, with `over` in place of some. */
export function dockActions(over: Partial<DockActions> = {}): DockActions {
  return {
    onAgents: vi.fn(),
    onDictate: vi.fn(),
    onDictationCancel: vi.fn(),
    onDictationDone: vi.fn(),
    onEdit: vi.fn(),
    onEffort: vi.fn(),
    onGoal: vi.fn(),
    onInterrupt: vi.fn(),
    onLoop: vi.fn(),
    onModel: vi.fn(),
    onPrs: vi.fn(),
    onQueueEdit: vi.fn(),
    onQueueSteer: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onSend: vi.fn(),
    onShells: vi.fn(),
    onSubmit: vi.fn(),
    onTodos: vi.fn(),
    onUndo: vi.fn(),
    ...over
  }
}

/** An idle dock with an empty composer, with `over` in place of some parts. */
export function dockContext(over: Partial<DockContext> = {}): DockContext {
  return {
    activity: { kind: 'idle' },
    composer: { attachments: [], draft: new Composer(), placeholder: '', ready: true },
    now: 0,
    pills: {},
    queue: { canSteer: false, rows: [] },
    route: { effort: '', model: 'm' },
    status: { branch: '' },
    ...over
  }
}

/** What dockModel() reads, for an idle session with nothing on show, with `over` in place of some. */
export function dockSources(over: Partial<DockSources> = {}): DockSources {
  return {
    activity: { busy: null, compacting: undefined },
    agents: { running: () => [] },
    attachments: { chips: () => [] },
    automation: { goal: null, loop: () => null, loopSnapshot: null },
    completion: { ghost: '' },
    composer: new Composer(),
    dictation: { capturing: false, heard: '', key: recordKey(undefined), phase: 'off' },
    hud: { focused: undefined, todosOpen: false },
    notices: { current: () => undefined },
    overlays: [],
    processes: { recent: () => [] },
    prs: { entries: () => [] },
    queue: { rows: () => [] },
    reconnect: { redial: undefined },
    session: { info: null, ref: { live: null }, usage: null },
    title: { text: '' },
    transcript: { currentTodos: () => undefined },
    ...over
  }
}
