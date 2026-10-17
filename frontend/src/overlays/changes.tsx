// The Changes sheet (`/changes`, a file in the sidebar): what changed in the session's checkout since
// its last commit, staged or not, with each file's diff below the list. C copies the path.

import type { JSX, Key, PickerItem } from '@stencil-hq/tern'

import type { App } from '../app.js'
import { copyToClipboard } from '../clipboard.js'
import { type ChangedFile, fileDiff, type GitState, gitState } from '../git/status.js'
import type { Overlay } from '../overlay.js'

import { moveSelection } from './search.js'

const KEY = 'changes'

const TONE: Record<string, 'error' | 'info' | 'success' | 'warning'> = {
  added: 'success',
  conflicted: 'error',
  deleted: 'error',
  renamed: 'info',
  untracked: 'success'
}

/** Opens the sheet, on file `focus` when given. */
export function openChanges(app: App, focus?: string) {
  let state: GitState | undefined = app.sidebar.state
  let selected = focus
  let failed = false
  /** Each file's diff; null while it is read. */
  const diffs = new Map<string, string | null>()

  const read = async () => {
    const cwd = app.info?.cwd

    state = cwd ? await gitState(cwd) : undefined
    failed = !state
    diffs.clear()
    app.changed()
  }

  const load = (f: ChangedFile | undefined) => {
    if (!f || !state || diffs.has(f.path)) {
      return
    }

    diffs.set(f.path, null)
    void fileDiff(state.root, f).then(text => {
      diffs.set(f.path, text)
      app.changed()
    })
  }

  void read()

  const files = () => state?.files ?? []
  const current = () => files().find(f => f.path === selected)

  const overlay: Overlay = {
    key: KEY,
    modal: true,
    node: () => sheetNode(),
    onKey: (k: Key) => {
      if (k.name === 'escape') {
        app.close(overlay)
      } else if (k.name === 'c' && !k.ctrl && !k.alt && !k.meta && current()) {
        copyToClipboard(current()!.path)
      } else if (k.name === 'r' && k.shift) {
        void read()
      } else {
        selected =
          moveSelection(
            k,
            files().map(f => f.path),
            selected
          ) ?? selected
      }

      return true
    }
  }

  function sheetNode(): JSX.Element {
    const list = files()

    if (!list.some(f => f.path === selected)) {
      selected = list[0]?.path
    }

    const f = current()
    load(f)
    const diff = f ? diffs.get(f.path) : undefined
    const added = list.reduce((n, x) => n + x.additions, 0)
    const removed = list.reduce((n, x) => n + x.deletions, 0)

    return (
      <picker
        actions={[
          { disabled: f ? undefined : 'No file', id: 'copy', keys: ['c'], label: 'Copy path' },
          { id: 'refresh', keys: ['shift+r'], label: 'Refresh' },
          { end: true, id: 'close', keys: ['esc'], label: 'Close', primary: true }
        ]}
        columns={[{ format: 'dim', head: 'Changes', id: 'changes', priority: 2 }]}
        empty={failed ? 'This folder is not in a git repository.' : state ? 'Nothing changed since the last commit.' : 'Reading git…'}
        icon="diff"
        items={list.map(item)}
        key={KEY}
        noun="files"
        onAction={{
          close: () => app.close(overlay),
          copy: () => f && copyToClipboard(f.path),
          refresh: () => void read()
        }}
        onSelect={ev => {
          selected = ev.item
          app.changed()
        }}
        order={list.map(x => x.path)}
        preview="below"
        selected={selected}
        size="lg"
        state={state || failed ? 'ready' : 'loading'}
        subtitle={[
          { s: 'muted', t: state?.branch ? `${state.branch} · ` : '' },
          { s: 'success', t: `+${added}` },
          { t: ' ' },
          { s: 'error', t: `−${removed}` }
        ]}
        title="Changes"
        total={list.length}
      >
        {f ? diffView(f, diff) : null}
      </picker>
    )
  }

  app.open(overlay)
}

function item(f: ChangedFile): PickerItem {
  return {
    badges: [
      ...(f.status !== 'modified' ? [{ text: f.status, tone: TONE[f.status] }] : []),
      ...(f.staged ? [{ text: 'staged' }] : [])
    ],
    detail: f.from ? `from ${f.from}` : undefined,
    facts: { changes: [{ s: 'success', t: `+${f.additions}` }, { t: ' ' }, { s: 'error', t: `−${f.deletions}` }] },
    id: f.path,
    label: f.path,
    mono: true
  }
}

function diffView(f: ChangedFile, diff: string | null | undefined): JSX.Element[] {
  if (diff === undefined || diff === null) {
    return [<text key="wait" spans={[{ s: 'muted', t: 'Reading the diff…' }]} />]
  }

  if (!diff.trim()) {
    return [<text key="none" spans={[{ s: 'muted', t: 'No line changed (a mode or a rename only).' }]} />]
  }

  return /^Binary files /m.test(diff)
    ? [<text key="bin" spans={[{ s: 'muted', t: 'Binary file.' }]} />]
    : [<diff key={`d:${f.path}`} path={f.path} text={diff} />]
}
