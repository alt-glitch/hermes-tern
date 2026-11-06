// Read-only prepared OpenUI summary: the existing Hermes preview contract
// remains the validator, and Tern's separately installed file route renders it.
import type { Key } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import { errorText } from '../core/errors.js'
import type { Entry } from '../model.js'
import { actionsRow } from '../view/ui/button.js'
import { type PreparedVisual, readPreparedVisual, visualScope } from '../visuals.js'

import type { Overlay } from './overlay.js'

export type VisualHost = Pick<ChatPorts, 'changed' | 'close' | 'open' | 'overlays' | 'session' | 'transcript'>
export type LoadVisual = (path: string, scope: string, signal: AbortSignal) => Promise<PreparedVisual>

/** A file link is not an approval or atomic handoff: Tern reopens the bytes. */
export async function openVisual(
  host: VisualHost,
  path: string,
  load: LoadVisual = readPreparedVisual,
  expectedId?: string
): Promise<void> {
  const sid = host.session.ref.live
  const scope = visualScope(host)
  const entries: readonly Entry[] = host.transcript.entries
  const controller = new AbortController()
  let candidate: PreparedVisual | undefined
  let error = ''
  let expired = false

  const current = () => {
    // Once any change is observed, returning to the previous value cannot unexpire this sheet.
    expired ||= host.session.ref.live !== sid || visualScope(host) !== scope || host.transcript.entries !== entries

    return !expired && host.overlays.includes(overlay)
  }

  const close = () => {
    controller.abort()
    host.close(overlay)
  }

  const overlay: Overlay = {
    key: 'visual-preview',
    modal: true,
    node: () => {
      const valid = current()

      return (
        <overlay anchor="center" head="Visual preview" key="visual-preview" modal role="omp.overlay.visual" size="lg">
          <col gap="md" key="body">
            {!valid ? (
              <text key="expired" text="Session, branch or transcript changed. Reopen /visual in its owning session." />
            ) : !scope ? (
              <text key="unavailable" text="Start a session before opening a visual preview." />
            ) : !path ? (
              <col gap="sm" key="usage">
                <text key="command" text="/visual /absolute/path/to/candidate.hvisual.json" />
                <text key="scope-label" text="Prepare an OpenUI bundle or a card.v0 document with this exact scope argument:" />
                <text key="scope" text={scope} />
                <text
                  key="discovery"
                  text="Run openui/prepare.mjs prepare, prepare-intent or prepare-card through the agent terminal with --json, then reopen /visual."
                />
                <text key="note" text="No generation, validation bypass, approval, installation, publication or sharing occurs here." />
              </col>
            ) : error ? (
              <text key="error" text={error} tone="error" />
            ) : candidate ? (
              <col gap="sm" key="candidate">
                <text key="title" text={candidate.title} />
                <text key="status" text="Preview only · not visually verified or published" tone="warning" />
                {candidate.card ? (
                  <col gap="sm" key="card-summary">
                    <kv
                      key="card-fields"
                      items={[
                        { k: 'Kind', v: candidate.card.kind },
                        { k: 'App', v: candidate.card.app },
                        { k: 'Title', v: candidate.title },
                        ...candidate.card.texts.map(field => ({ k: field.label, v: field.value }))
                      ]}
                    />
                    <text
                      key="action-policy"
                      text={'Card action policy: ' + candidate.card.actions + ' (informational only)'}
                    />
                    {candidate.card.buttons.length ? (
                      <col gap="sm" key="card-buttons">
                        <text key="buttons-label" text="Buttons (labels only, disabled)" />
                        {candidate.card.buttons.map((label, index) => (
                          <text key={'button-label-' + index} text={label} />
                        ))}
                      </col>
                    ) : null}
                    <text key="inert" text="Host-owned read-only summary. No button, action, script or approval runs." />
                  </col>
                ) : (
                  <col gap="sm" key="openui-summary">
                    <kv items={candidate.metrics.map(metric => ({ k: metric.label, v: String(metric.value) }))} key="metrics" />
                    {candidate.sections ? (
                      <text key="mode" text={'Intent board: ' + candidate.sections.join(' · ')} />
                    ) : (
                      <text key="mode" text={'Initial mode: ' + candidate.mode} />
                    )}
                    <text key="file" spans={[{ t: 'Open candidate file in Tern', href: candidate.href, s: 'link' }]} />
                    <text
                      key="route"
                      text="The separately enabled hermes-openui file route opens the Luau viewer. Opening the file reads current bytes again."
                    />
                  </col>
                )}
                <text key="identity" text={'Bundle: ' + candidate.id} />
              </col>
            ) : (
              <text key="loading" text="Checking prepared visual…" />
            )}
            {actionsRow([{ hint: 'escape', key: 'close', label: 'Close', onClick: close }])}
          </col>
        </overlay>
      )
    },
    onKey: (key: Key) => {
      if (!current() || key.name === 'escape' || key.name === 'q') {
        close()
      }

      return true
    },
    onClose: () => controller.abort()
  }

  host.open(overlay)

  if (!scope || !path) {
    return
  }

  try {
    const loaded = await load(path, scope, controller.signal)

    if (!current() || controller.signal.aborted) {
      return
    }

    if (expectedId && loaded.id !== expectedId) {
      throw new Error('The file no longer matches the reported bundle. Prepare it again.')
    }

    candidate = loaded
  } catch (cause) {
    if (!current() || controller.signal.aborted) {
      return
    }

    error = errorText(cause)
  }

  if (current()) {
    host.changed()
  }
}
