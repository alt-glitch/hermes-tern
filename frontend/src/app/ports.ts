// What the app lends the modules it drives: the sheets, the sidebar, the PR aside and the slash
// commands. Each consumer names the few ports it uses (`Pick<ChatPorts, …>`), so none of them
// imports App, and App is the one place that implements them all. The names are the ones the
// ports keep: a later package changes what stands behind a port, not the code that reads it.

import type { ScrollTo } from '@stencil-hq/tern'
import type { GatewayClient } from '@tui/gatewayClient.js'
import type { SessionInfo } from '@tui/types.js'

import type { Agents } from '../agents/store.js'
import type { SessionHost } from '../commands/session.js'
import type { Dictation } from '../draft/dictation.js'
import type { PrKey, SessionIds, StoredSessionId } from '../core/ids.js'
import type { GitState } from '../git/status.js'
import type { PullRequests } from '../github/store.js'
import type { NoticeEntry } from '../model.js'
import type { OverlayHost, Overlay } from '../overlays/overlay.js'
import type { Cron } from '../processes/cron.js'
import type { Processes } from '../processes/store.js'
import type { Automation } from '../session/automation.js'
import type { ThemeMode } from '../settings.js'
import type { Transcript } from '../transcript/store.js'
import type { Busy } from '../turn/activity.js'

/** The session as the ports read it, live: each read sees the current ids and info. */
export interface SessionView {
  /** The open session's ids: `live` for the gateway's requests, `durable(ref)` to file or resume it. */
  readonly ref: SessionIds
  /**
   * The gateway's session.info, merged. Writable: a picker that switched the model or the fast
   * tier shows the change before the gateway's next session.info confirms it.
   */
  info: SessionInfo | null
}

/** Everything the app lends; a consumer takes `Pick<ChatPorts, …>` of it. */
export interface ChatPorts extends OverlayHost {
  readonly session: SessionView
  readonly gw: GatewayClient
  /** The running turn, null when idle. */
  readonly busy: Busy | null
  readonly transcript: Transcript
  readonly agents: Agents
  readonly processes: Processes
  readonly cron: Cron
  readonly prs: PullRequests
  readonly automation: Automation
  /** Dictation into the composer: `/voice` turns it on and off. */
  readonly dictation: Pick<Dictation, 'disable' | 'enable' | 'key' | 'phase'>
  /** The session sidebar's last read of git, which the Changes sheet starts from. */
  readonly sidebar: { readonly state: GitState | undefined }
  /** The open overlays, bottom first. */
  readonly overlays: readonly Overlay[]
  /** Whose colors hermes wears. */
  readonly theme: ThemeMode
  /** A notice in the transcript, rendered now. */
  notice(text: string, tone?: NoticeEntry['tone']): void
  /** Brings node `id` into view. */
  reveal(id: string): void
  /** Scrolls the scroll container holding node `id`. */
  scroll(id: string, to: ScrollTo): void
  /** Switches the theme mode now and keeps it for the next launch. */
  setTheme(mode: ThemeMode): void
  /** Sets the reasoning effort for this session, or as config.yaml's default for every new one. */
  setEffort(value: string, scope: 'global' | 'session'): Promise<void>
  /** Shows subagent `id` beside the chat, or in its timeline sheet. */
  openAgent(id: string): Promise<void>
  /** Opens the help sheet. */
  openHelp(): Promise<void>
  /** Docks PR `key` at the pane's right edge, in place of the session sidebar. */
  openPrAside(key: PrKey | undefined): void
  /** Shows or hides the session sidebar. */
  toggleSidebar(): void
  /** Starts a new session, named `title` when given. */
  newSession(title?: string): Promise<void>
  /** Switches this pane to stored session `id`. */
  resume(id: StoredSessionId): Promise<void>
  /** Ends the app with exit code `code`. */
  quit(code?: number): void
  /** Attaches the clipboard's image to the next prompt; `quiet`: no notice when it holds none. */
  attachClipboardImage(quiet: boolean): Promise<void>
  /** Attaches the image file at `raw` to the next prompt. */
  attachImagePath(raw: string): Promise<void>
  /** What the control and session commands reach of the app. */
  control(): SessionHost
}
