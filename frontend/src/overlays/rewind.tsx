// The rewind sheet (`/rewind`): this session's prompts as a timeline, from a fresh snapshot of the
// shared gateway, each with its reply; the newest is picked. Enter rewinds to before the picked
// prompt, after a confirm, and puts its text back in the composer to edit and send, as the CLI's
// /undo does. B branches instead: a copy of the session up to that prompt (`session.mutate` branch
// with `through_message_id`), which the view moves to with the prompt in its composer; the
// original keeps its history. Either write re-reads the session and goes ahead only while the
// picked row is still that prompt, at the revision it read.

import type { JSX, Key, PickerItem } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import type { SessionHost } from '../commands/session.js'
import { optional } from '../core/assert.js'
import { errorText } from '../core/errors.js'
import { storedSessionId } from '../core/ids.js'
import { plural } from '../core/text.js'
import { mutateSession } from '../hermes/mutate.js'
import { promptRows, type PromptRow, promptText, rowBefore, userTurn } from '../hermes/rewind.js'
import { oneLine } from '../view/describe.js'
import { facts } from '../view/ui/facts.js'
import { rpc } from '../wire/rpc.js'

import type { Overlay } from './overlay.js'
import { moveSelection } from './search.js'

/** What the rewind sheet reaches of the app. */
export type RewindHost = Pick<ChatPorts, 'changed' | 'close' | 'control' | 'open'>

const KEY = 'rewind'

const idOf = (p: PromptRow) => String(p.row)

/** Refuses while a turn runs or prompts wait: the owner refuses a rewind of a session that is not idle. */
function blocked(session: SessionHost): boolean {
  if (session.busy || session.queued) {
    session.notice('Wait for the current turn to finish (or press Esc twice) before rewinding.', 'warning')

    return true
  }

  return false
}

/** The text a rewound prompt comes back as: the owner's copy of the row, else the one the sheet read. */
function comeback(result: Record<string, unknown>, picked: PromptRow): { text: string; media: boolean } {
  const target = result['target_message']

  return typeof target === 'object' && target !== null && 'content' in target ? promptText(target.content) : picked
}

/** Rewinds session `session` to before `p`; its text goes back in the composer. */
async function rewindTo(session: SessionHost, sid: string, p: PromptRow) {
  const result = await mutateSession(session.gw, sid, 'rewind', snap => (userTurn(snap, p.row) ? { target_message_id: p.row } : null))

  if (session.stale()) {
    return
  }

  if (!result) {
    return session.notice('That prompt is no longer in this session: nothing was rewound.', 'warning')
  }

  const removed = Number(result['rewound_count'] ?? 0)

  if (removed <= 0) {
    return session.notice('Nothing to rewind.')
  }

  await session.reload()

  if (session.stale()) {
    return
  }

  const back = comeback(result, p)

  if (back.text) {
    session.draft(back.text)
  }

  session.notice(
    `Rewound ${plural(removed, 'message')}.${back.text ? ' The prompt is back in the composer.' : ''}${back.media ? ' Its images are not: attach them again.' : ''}`
  )
}

/** Branches session `sid` before `p` and moves the view to the branch, with `p` in its composer. */
async function branchAt(host: RewindHost, session: SessionHost, sid: string, p: PromptRow) {
  const result = await mutateSession(session.gw, sid, 'branch', snap => {
    const through = userTurn(snap, p.row) ? rowBefore(snap, p.row) : null

    return through === null ? null : { through_message_id: through }
  })

  if (!result) {
    return session.notice('That prompt is no longer in this session: nothing was branched.', 'warning')
  }

  const child = result.branched_session_id

  if (typeof child !== 'string' || !child) {
    throw new Error('the gateway did not name the branch')
  }

  if (session.stale() || !(await session.open(storedSessionId(child)))) {
    return
  }

  // The view is on the branch now; `session` names the one it left.
  const branch = host.control()

  if (p.text) {
    branch.draft(p.text)
  }

  branch.notice(
    `Branched before that prompt; the original keeps it.${p.text ? ' The prompt is in the composer.' : ''}${p.media ? ' Its images are not: attach them again.' : ''}`
  )
}

/** Opens the rewind sheet on the shown session. */
export function openRewind(host: RewindHost) {
  // Bound to the session shown now: stale() once the view leaves it.
  const session = host.control()
  const sid = session.sid

  if (!session.canonical) {
    return session.notice("Rewinding to an earlier prompt needs Hermes' shared gateway.", 'warning')
  }

  if (!sid) {
    return session.notice('Nothing to rewind.')
  }

  if (blocked(session)) {
    return
  }

  let state: 'error' | 'loading' | 'ready' = 'loading'
  let failure = ''
  /** Oldest first. */
  let prompts: PromptRow[] = []
  let selected: string | undefined
  let confirming = false

  const load = async () => {
    state = 'loading'
    host.changed()

    try {
      const snapshot = await rpc(session.gw, 'session.resume', { session_id: sid })

      if (!snapshot || !('revision' in snapshot)) {
        throw new Error('the session did not report its stored messages')
      }

      prompts = promptRows(snapshot)
      const newest = prompts.at(-1)
      selected = newest ? idOf(newest) : undefined
      state = 'ready'
    } catch (error) {
      failure = errorText(error)
      state = 'error'
    }

    host.changed()
  }

  const picked = () => prompts.find(p => idOf(p) === selected)

  const act = (run: (p: PromptRow) => Promise<unknown>, name: string) => {
    const p = picked()

    if (!p || session.stale()) {
      return
    }

    host.close(overlay)

    if (blocked(session)) {
      return
    }

    run(p).catch((error: unknown) => session.notice(`${name} failed: ${errorText(error)}`, 'error'))
  }

  const rewind = () => act(p => rewindTo(session, sid, p), 'Rewind')
  const branch = () => {
    if (picked() !== prompts[0]) {
      act(p => branchAt(host, session, sid, p), 'Branch')
    }
  }

  const ask = () => {
    confirming = Boolean(picked())
  }

  const overlay: Overlay = {
    key: KEY,
    modal: true,
    node: () => {
      const p = picked()
      // The first prompt has nothing before it to copy: that branch is /new.
      const noBranch = p ? (p === prompts[0] ? 'Nothing comes before the first prompt: /new starts afresh' : undefined) : 'No prompt'

      return (
        <picker
          actions={[
            { ...optional('disabled', noBranch), id: 'branch', keys: ['b'], label: 'Branch here' },
            { end: true, id: 'close', keys: ['esc'], label: 'Close' },
            { ...optional('disabled', p ? undefined : 'No prompt'), danger: true, id: 'rewind', keys: ['enter'], label: 'Rewind', primary: true }
          ]}
          columns={[{ format: 'dim', id: 'after', priority: 1 }]}
          key={KEY}
          {...optional(
            'confirm',
            confirming && p
              ? {
                  act: 'confirm',
                  label: 'Rewind',
                  text: `Remove this prompt${p.after ? ` and ${plural(p.after, 'later one')}` : ''}?`
                }
              : undefined
          )}
          empty="No prompts in this session yet"
          icon="history"
          items={prompts.map(itemOf)}
          layout="timeline"
          {...optional('message', state === 'error' ? [{ s: 'error', t: failure }] : undefined)}
          noun="prompts"
          onAction={{
            branch,
            cancel: () => {
              confirming = false
              host.changed()
            },
            close: () => host.close(overlay),
            confirm: rewind,
            retry: () => void load(),
            rewind: () => {
              ask()
              host.changed()
            }
          }}
          onActivate={ev => {
            selected = ev.item
            ask()
            host.changed()
          }}
          onSelect={ev => {
            selected = ev.item
            confirming = false
            host.changed()
          }}
          order={prompts.map(idOf)}
          preview="side"
          {...optional('selected', selected)}
          size="lg"
          state={state}
          title="Rewind"
          total={prompts.length}
        >
          {p ? promptPreview(p, prompts.indexOf(p)) : null}
        </picker>
      )
    },
    onKey: (k: Key) => {
      if (confirming) {
        if (k.name === 'enter' || k.name === 'y') {
          rewind()
        } else if (k.name === 'escape' || k.name === 'n') {
          confirming = false
        }

        return true
      }

      if (k.name === 'escape') {
        host.close(overlay)
      } else if (k.name === 'enter') {
        ask()
      } else if (k.name === 'b' && !k.ctrl && !k.meta) {
        branch()
      } else {
        selected = moveSelection(k, prompts.map(idOf), selected) ?? selected
      }

      return true
    }
  }

  host.open(overlay)
  void load()
}

function itemOf(p: PromptRow): PickerItem {
  return {
    badges: [...(p.steer ? [{ text: 'steer' }] : []), ...(p.media ? [{ text: 'image', title: 'Its images do not come back' }] : [])],
    ...optional('detail', p.reply ? oneLine(p.reply) : undefined),
    facts: { after: p.after ? `${p.after} later` : 'newest' },
    id: idOf(p),
    label: oneLine(p.text) || '(no text)'
  }
}

/** The picked prompt, its reply, and what each answer does with it; `before`: the prompts before it. */
function promptPreview(p: PromptRow, before: number): JSX.Element[] {
  return [
    <kv
      items={facts([
        ['Rewind removes', `this prompt${p.after ? ` and ${plural(p.after, 'later one')}` : ''}, with the replies`],
        ['A branch keeps', before ? `${plural(before, 'earlier prompt')}; this session stays as it is` : 'nothing: this is the first prompt'],
        ['Files', 'stay as they are (/rollback restores them)']
      ])}
      key="facts"
    />,
    <section head="Prompt" key="prompt">
      <md key="text" max={{ h: '8lines' }} text={p.text || '(no text)'} tone="user" />
    </section>,
    ...(p.reply
      ? [
          <section head="Reply" key="reply">
            <md key="text" max={{ h: '14lines' }} text={p.reply.slice(0, 2000)} />
          </section>
        ]
      : [])
  ]
}
