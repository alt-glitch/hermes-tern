// The Files tab of a pull request: each changed file as Tern's own edit card with its diff (a
// long or deleted one folded), and in a wide view the list of files beside them.

import type { JSX, Tone } from '@stencil-hq/tern'
import { node } from '@stencil-hq/tern'

import { langOf } from '../code/lang.js'
import type { PrFile, PullRequest } from '../github/pullRequest.js'
import type { Entry } from '../github/store.js'

/** How much room the view has: `wide` draws the files beside their list. */
export type PrDensity = 'narrow' | 'wide'

/** A diff longer than this many lines starts folded. */
const LONG_DIFF = 400

/**
 * The Files tab: each file as Tern's edit card with its diff. `wide` puts the list of files beside
 * the cards; a click on one brings its card into view (`reveal`).
 */
export function filesTab(e: Entry, pr: PullRequest, id: string, density: PrDensity, reveal?: (id: string) => void): JSX.Element[] {
  if (!e.files) {
    return [<text key="load" spans={[{ s: e.filesError ? 'error' : 'muted', t: e.filesError ?? 'Reading the files…' }]} />]
  }

  if (!e.files.length) {
    return [<text key="none" spans={[{ s: 'muted', t: 'No files changed.' }]} />]
  }

  const cards = e.files.map((f, i) => fileCard(f, `f${i}`))

  if (density === 'narrow') {
    return cards
  }

  const list = (
    <col gap="none" key="list" role="hermes.pr.filelist">
      {e.files.map((f, i) => {
        const slash = f.path.lastIndexOf('/')

        return (
          <row align="center" gap="sm" key={`l${i}`} onClick={() => reveal?.(`${id}.diffs.f${i}`)} role="hermes.pr.fileitem" title={f.path}>
            <icon key="i" name="file" tone={FILE_TONE[f.status]} />
            <text
              grow={1}
              key="p"
              spans={[...(slash > 0 ? [{ s: 'dim', t: f.path.slice(0, slash + 1) }] : []), { t: f.path.slice(slash + 1) }]}
              truncate="start"
              wrap="none"
            />
            <text key="n" shrink={0} spans={[{ s: 'success', t: `+${f.additions}` }, { t: ' ' }, { s: 'error', t: `−${f.deletions}` }]} wrap="none" />
          </row>
        )
      })}
      {e.files.length < pr.changedFiles ? <text key="more" spans={[{ s: 'muted', t: `${pr.changedFiles - e.files.length} more on GitHub` }]} /> : null}
    </col>
  )

  return [
    <row align="start" gap="md" key="files" role="hermes.pr.files">
      {list}
      <col gap="sm" grow={1} key="diffs" min={{ w: 0 }}>
        {cards}
      </col>
    </row>
  ]
}

const FILE_TONE: Record<string, Tone> = { added: 'success', removed: 'error', renamed: 'info' }

const FILE_TITLE: Record<string, string> = { added: 'Added', copied: 'Copied', modified: 'Changed', removed: 'Deleted', renamed: 'Renamed' }

/** A file as Tern's own edit card: its path in the head, its diff in the body. */
function fileCard(f: PrFile, key: string): JSX.Element {
  const lines = f.patch ? f.patch.split('\n').length : 0

  return node(
    'tool',
    {
      badges: f.previous ? [{ text: `from ${f.previous}` }] : undefined,
      collapsed: f.status === 'removed' || lines > LONG_DIFF,
      collapsible: true,
      key,
      meta: [`+${f.additions} −${f.deletions}`],
      name: f.status === 'added' ? 'write' : 'edit',
      role: 'hermes.pr.file',
      status: 'done',
      target: f.path,
      targetKind: 'path',
      title: FILE_TITLE[f.status] ?? 'Changed'
    },
    f.patch
      ? [<diff key="d" lang={langOf(f.path)} path={f.path} text={f.patch} />]
      : [<text key="none" spans={[{ s: 'muted', t: 'Binary, or too large to show here.' }]} />]
  )
}
