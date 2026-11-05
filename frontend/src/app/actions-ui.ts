// Tern-facing media, pills and side-panel actions, with AppActions retaining its public API.

import type { Key } from '@stencil-hq/tern'

import type { Artifacts } from '../artifacts.js'
import type { SheetPill } from '../chrome/hud.js'
import type { PrKey } from '../core/ids.js'
import type { ToolCall } from '../model.js'
import { openAgents } from '../overlays/agents.js'
import { openAutomation } from '../overlays/automation.js'
import { openBackground } from '../overlays/background.js'
import { openPrMenu, openPrSheet } from '../overlays/pullRequests.js'
import { shownPills } from '../view/dockModel.js'

import { openAgentPane } from './agent-pane.js'
import type { ActionsCx } from './actions.js'
import { toolBlob } from './tool-blob.js'

export function blob(cx: ActionsCx, bytes: Uint8Array, mime: string): string | undefined {
  return toolBlob(cx.tern, bytes, mime)
}

export function showImage(cx: ActionsCx, call: ToolCall | undefined, imageLanded: (call: ToolCall) => void) {
  if (call) cx.media.show(call, () => imageLanded(call))
}

export function showArtifacts(cx: ActionsCx, artifacts: Artifacts, call: ToolCall | undefined) {
  artifacts.show(call, cx.state.info?.cwd ?? process.cwd(), text => {
    cx.transcript.notice(text, 'warning')
    cx.changed()
  })
}

export function imageLanded(cx: ActionsCx, call: ToolCall) {
  cx.transcript.touchCall(call)
  cx.changed()
}

export function hudKey(cx: ActionsCx, key: Key): boolean {
  const { activity, chat, completion, composer, transcript, todoHud } = cx
  const { agents, automation, processes, prs } = chat

  return cx.hud.key(key, {
    idle: !composer.text && !composer.browsing && !completion.open,
    pills: shownPills({ activity, agents, automation, processes, prs, todoHud, transcript }, Date.now())
  })
}

export function openPill(cx: ActionsCx, pill: SheetPill) {
  const chat = cx.chat
  if (pill === 'agents') openAgents(chat)
  else if (pill === 'shells') openBackground(chat)
  else if (pill === 'prs') openPrMenu(chat)
  else openAutomation(chat, pill)
}

export function toggleSidebar(cx: ActionsCx) {
  const { prAside, sidebar } = cx

  if (!cx.tern.caps.features.includes('aside')) {
    cx.transcript.notice('This Tern has no side panel (the aside feature). /changes and /prs still work.', 'warning')
    cx.changed()

    return
  }

  // One sheet docks at the edge at a time: the session sidebar takes the PR aside's place.
  if (!sidebar.open && prAside.open) {
    prAside.close()
  }

  sidebar.toggle()
}

export function openPrAside(cx: ActionsCx, key: PrKey | undefined) {
  if (!cx.tern.caps.features.includes('aside')) {
    return openPrSheet(cx.chat, key)
  }

  if (cx.sidebar.open) {
    cx.sidebar.toggle()
  }

  cx.prAside.show(key)
}

export async function openAgent(cx: ActionsCx, id: string) {
  return openAgentPane(cx, id)
}
