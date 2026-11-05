// Split code review reached from /changes: existing git diff cache and draft-only notes.
import type { JSX, Key } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import { langOf } from '../code/lang.js'
import { reviewHunks, reviewSide, reviewTargets, type ReviewHunk } from '../code/review.js'
import { optional } from '../core/assert.js'
import { Composer } from '../draft/composer.js'
import type { ChangedFile } from '../git/status.js'
import { actionsRow, pressable } from '../view/ui/button.js'

import { nativeOverlayKey } from './identity.js'
import type { Overlay } from './overlay.js'

export type CodeReviewHost = Pick<ChatPorts, 'changed' | 'close' | 'control' | 'open' | 'overlays'>

export interface CodeReviewSource {
  files: readonly ChangedFile[]
  diffs: ReadonlyMap<string, string | null>
  load(file: ChangedFile): void
  parent: Overlay
}

function splitView(hunk: ReviewHunk, index: number, language: string): JSX.Element {
  return (
    <col gap="xs" key={'hunk-' + index} role="omp.review.hunk">
      <text key="header" spans={[{ s: 'muted mono', t: hunk.header }]} wrap="none" />
      <row gap="sm" key="sides" role="omp.review.split">
        <col grow={1} key="old" min={{ w: 0 }} role="omp.review.old">
          <text key="label" text="OLD" />
          <code key={'old-code-' + index} lang={language} text={reviewSide(hunk, 'old')} />
        </col>
        <col grow={1} key="new" min={{ w: 0 }} role="omp.review.new">
          <text key="label" text="NEW" />
          <code key={'new-code-' + index} lang={language} text={reviewSide(hunk, 'new')} />
        </col>
      </row>
    </col>
  )
}

/** Opens a review on the current Changes file; Esc goes back to Changes. */
export function openCodeReview(host: CodeReviewHost, source: CodeReviewSource, focus?: string): void {
  const control = host.control()
  let selected = source.files.some(file => file.path === focus) ? focus : source.files[0]?.path
  let targetIndex = 0
  let editing = false
  let version = 0
  let closed = false
  const note = new Composer()

  const active = () => !closed && !control.stale() && host.overlays.at(-1) === overlay
  const current = (stamp: number) => active() && stamp === version
  const file = () => source.files.find(item => item.path === selected)
  const targets = () => reviewTargets(reviewHunks(selected ? source.diffs.get(selected) ?? '' : ''))

  const choose = (path: string, stamp: number) => {
    if (!current(stamp) || selected === path || !source.files.some(item => item.path === path)) return
    selected = path
    targetIndex = 0
    editing = false
    note.set('')
    version++
    host.changed()
  }

  const close = () => {
    if (active()) host.close(overlay)
  }

  const cancelNote = () => {
    if (!active()) return
    editing = false
    note.set('')
    version++
    host.changed()
  }

  const startNote = (stamp: number) => {
    if (!current(stamp) || !file() || !targets()[targetIndex]) return
    editing = true
    note.set('')
    version++
    host.changed()
  }

  const insertNote = (stamp: number) => {
    if (!current(stamp) || !editing) return
    const target = targets()[targetIndex]
    const picked = file()
    const text = note.text.trim()
    if (!target || !picked || !text) return

    // SessionHost.draft prepends to the existing composer and retains pasted text.
    // It never sends, steers, queues, or changes the gateway session.
    control.draft(picked.path + ':' + target.line + ': ' + text)
    host.close(overlay)
    host.close(source.parent)
  }

  const render = (id: string): JSX.Element => {
    const stamp = version
    const picked = file()
    if (picked) source.load(picked)
    const diff = picked ? source.diffs.get(picked.path) : undefined
    const hunks = diff ? reviewHunks(diff) : []
    const anchors = reviewTargets(hunks)
    const target = anchors[targetIndex]
    const pathLine = picked && target ? picked.path + ':' + target.line : ''
    const language = langOf(picked?.path) ?? 'text'

    return (
      <overlay anchor="center" head="Code review" key={nativeOverlayKey(id)} modal role="omp.overlay.codeReview" size="full">
        <col gap="sm" key="body">
          <text key="hint" text="j/k files · up/down changed lines · n note · Esc back to Changes" />
          <row gap="md" key="layout" role="omp.review.layout">
            <col gap="xs" key="rail" min={{ w: 18 }} role="omp.review.files">
              <text key="heading" text="Files" />
              {source.files.map((item, index) => pressable(
                { key: 'file-' + index, name: 'Review ' + item.path, onClick: () => choose(item.path, stamp) },
                <row gap="xs" key="face" {...optional('mark', selected === item.path ? 'pick' : undefined)} role="omp.review.file">
                  <text key="path" text={item.path} wrap="word" />
                </row>
              ))}
            </col>
            <col gap="sm" grow={1} key="detail" min={{ w: 0 }} role="omp.review.detail">
              <text key="selected-path" spans={[{ s: 'strong path', t: picked?.path ?? 'No file selected' }]} wrap="word" />
              {!picked ? (
                <text key="empty" text="No changed files to review." />
              ) : diff === null || diff === undefined ? (
                <text key="loading" text="Reading the diff…" />
              ) : !hunks.length ? (
                <text key="empty-diff" text="No text hunks to review (binary, rename or mode-only change)." />
              ) : (
                <col gap="md" key="hunks" role="omp.review.hunks">
                  {hunks.map((hunk, index) => splitView(hunk, index, language))}
                </col>
              )}
              {target ? (
                <text key="target" text={'Changed line ' + pathLine + ' (' + target.side + ', ' +
                  (targetIndex + 1) + '/' + anchors.length + ')'} />
              ) : null}
              {editing && target ? (
                <col gap="sm" key="editor" role="omp.review.note">
                  <text key="note-hint" text={'Note for ' + pathLine + ' (inserts into draft; does not send)'} />
                  <input
                    aria="Code review note"
                    cursor={note.cursor}
                    key="note-input"
                    onEdit={ev => {
                      if (current(stamp) && editing) {
                        note.edit(ev)
                        host.changed()
                      }
                    }}
                    onUndo={() => {
                      if (current(stamp) && editing) {
                        note.undo()
                        host.changed()
                      }
                    }}
                    placeholder="Write a note for this line"
                    text={note.text}
                  />
                  {actionsRow([
                    { key: 'note-insert', label: 'Insert into draft', onClick: () => insertNote(stamp) },
                    { key: 'note-cancel', label: 'Cancel note', onClick: cancelNote }
                  ])}
                </col>
              ) : (
                actionsRow([
                  ...(target ? [{ key: 'note-start', label: 'Note at ' + pathLine, keys: ['n'], onClick: () => startNote(stamp) }] : []),
                  { key: 'review-back', label: 'Back to Changes', hint: 'escape', onClick: close }
                ])
              )}
            </col>
          </row>
        </col>
      </overlay>
    )
  }

  const overlay: Overlay = {
    key: 'code-review',
    modal: true,
    focus: id => editing ? id + '.body.layout.detail.editor.note-input' : null,
    node: render,
    onClose: () => { closed = true },
    onKey: (key: Key) => {
      if (!active()) return true

      if (key.name === 'escape') {
        if (editing) cancelNote()
        else close()
        return true
      }

      if (editing) {
        if (note.key(key) === 'submit') insertNote(version)
        host.changed()
        return true
      }

      if (!key.ctrl && !key.alt && !key.meta && (key.name === 'j' || key.name === 'k')) {
        const index = source.files.findIndex(item => item.path === selected)
        const next = Math.max(0, Math.min(source.files.length - 1, index + (key.name === 'j' ? 1 : -1)))
        const item = source.files[next]
        if (item) choose(item.path, version)
      } else if (!key.ctrl && !key.alt && !key.meta && (key.name === 'up' || key.name === 'down')) {
        const count = targets().length
        const next = Math.max(0, Math.min(count - 1, targetIndex + (key.name === 'down' ? 1 : -1)))
        if (count && next !== targetIndex) {
          targetIndex = next
          version++
          host.changed()
        }
      } else if (key.name === 'n' && !key.ctrl && !key.alt && !key.meta) {
        startNote(version)
      }

      return true
    }
  }

  host.open(overlay)
}
