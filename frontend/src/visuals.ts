// Prepared OpenUI previews from the Hermes ui-tsp experiment. The frontend
// projects already validated data; it never generates or approves a visual.
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { ChatPorts } from './app/ports.js'
import { type CardDocument, openCardContract } from './wire/card.js'
import { decodeJson, record } from './wire/json.js'
import { openUiContract } from './wire/openui.js'

interface RepositoryNode {
  readonly children: readonly RepositoryNode[]
}

interface RepositoryBundle {
  readonly id: string
  readonly selection: {
    readonly view: { readonly kind?: 'repo-explorer'; readonly mode: 'code' | 'churn'; readonly metrics: readonly ('files' | 'code' | 'churn')[] }
  }
  readonly artifact: {
    readonly document: { readonly title: string; readonly root: RepositoryNode & { readonly code: number; readonly churn: number } }
  }
}

/** An ephemeral-intent/v1 board (the ephemeral-ui intent kit): the model picked sections, the host document holds the values. */
interface IntentBundle {
  readonly id: string
  readonly selection: {
    readonly view: { readonly kind: 'intent-board'; readonly sections: readonly { readonly kind: string; readonly by?: string }[] }
  }
  readonly artifact: {
    readonly document: { readonly title: string; readonly work?: { readonly slices?: readonly unknown[] } }
  }
}

/** Public ephemeral-ui authored architecture v0; no discovery or verified links. */
interface ArchitectureBundle {
  readonly id: string
  readonly selection: { readonly view: { readonly kind: 'architecture-board' } }
  readonly artifact: {
    readonly document: {
      readonly title: string
      readonly nodes: readonly { readonly id: string; readonly service: string }[]
      readonly edges: readonly { readonly from: string; readonly to: string; readonly label: string }[]
    }
  }
}

export type VisualBundle = RepositoryBundle | IntentBundle | ArchitectureBundle

export interface VisualSummary {
  readonly id: string
  readonly title: string
  readonly mode: 'code' | 'churn' | 'intent' | 'card' | 'architecture'
  readonly metrics: readonly { readonly key: string; readonly label: string; readonly value: number }[]
  /** An intent board's sections in the order the model chose them (`DecisionMix(providers)`). */
  readonly sections?: readonly string[]
  readonly card?: {
    readonly kind: string
    readonly app: string
    readonly texts: readonly { readonly label: string; readonly value: string }[]
    readonly buttons: readonly string[]
    readonly actions: 'read-only' | 'host-confirmed'
  }
  /** Every authored edge explicitly remains intent, not a verified integration. */
  readonly edges?: readonly string[]
}

export interface PreparedVisual extends VisualSummary {
  readonly path: string
  readonly href: string
}

/** Unambiguous session/branch scope, using the durable session id where known. */
export function visualScope(host: Pick<ChatPorts, 'session'>): string | undefined {
  const { live, stored } = host.session.ref

  if (!live) {
    return undefined
  }

  const scope = JSON.stringify([stored || live, host.session.info?.branch ?? ''])

  return scope.length <= 256 ? scope : undefined
}

/** Project requested host metrics only, after full validation; never scan Git here. */
export function summarizeVisual(bundle: VisualBundle): VisualSummary {
  return isArchitecture(bundle) ? summarizeArchitecture(bundle) : isIntent(bundle) ? summarizeIntent(bundle) : summarizeRepository(bundle)
}

function isArchitecture(bundle: VisualBundle): bundle is ArchitectureBundle {
  return 'kind' in bundle.selection.view && bundle.selection.view.kind === 'architecture-board'
}

function summarizeArchitecture(bundle: ArchitectureBundle): VisualSummary {
  const { document } = bundle.artifact

  return Object.freeze({
    id: bundle.id,
    title: document.title,
    mode: 'architecture',
    metrics: Object.freeze([
      Object.freeze({ key: 'nodes', label: 'Nodes', value: document.nodes.length }),
      Object.freeze({ key: 'edges', label: 'Intent edges', value: document.edges.length })
    ]),
    edges: Object.freeze(document.edges.map(edge =>
      `Intent only: ${edge.from} → ${edge.to} · ${edge.label} — not verified integration`))
  })
}

function isIntent(bundle: VisualBundle): bundle is IntentBundle {
  return 'kind' in bundle.selection.view && bundle.selection.view.kind === 'intent-board'
}

function summarizeIntent(bundle: IntentBundle): VisualSummary {
  const { sections } = bundle.selection.view
  const slices = bundle.artifact.document.work?.slices?.length ?? 0

  return Object.freeze({
    id: bundle.id,
    title: bundle.artifact.document.title,
    mode: 'intent',
    metrics: Object.freeze([
      Object.freeze({ key: 'sections', label: 'Sections', value: sections.length }),
      Object.freeze({ key: 'slices', label: 'Work slices', value: slices })
    ]),
    sections: Object.freeze(sections.map(x => (x.by ? `${x.kind}(${x.by})` : x.kind)))
  })
}

function summarizeRepository(bundle: RepositoryBundle): VisualSummary {
  const { document } = bundle.artifact
  const { metrics, mode } = bundle.selection.view
  let files = 0

  if (metrics.includes('files')) {
    const stack = [...document.root.children]

    while (stack.length) {
      const node = stack.pop()

      if (!node) {
        continue
      }

      if (node.children.length) {
        stack.push(...node.children)
      } else {
        files++
      }
    }
  }

  const values = {
    files: { label: 'Files', value: files },
    code: { label: 'Text lines', value: document.root.code },
    churn: { label: 'File touches', value: document.root.churn }
  }

  return Object.freeze({
    id: bundle.id,
    title: document.title,
    mode,
    metrics: Object.freeze(metrics.map(key => Object.freeze({ key, ...values[key] })))
  })
}

/** Show only validated inert text and labels, never card instructions or callbacks. */
function summarizeCard(card: CardDocument, id: string): VisualSummary {
  const labels: Readonly<Record<string, string>> = {
    text: 'Text',
    summary: 'Summary',
    description: 'Description',
    subject: 'Subject',
    status: 'Status',
    label: 'Label',
    query: 'Query',
    body: 'Body',
    message: 'Message',
    note: 'Note'
  }
  const texts = Object.entries(labels).flatMap(([key, label]) => {
    const value = card[key]

    return typeof value === 'string' ? [Object.freeze({ label, value })] : []
  })
  const extra = Object.entries(card.fields ?? {}).map(([label, value]) => Object.freeze({ label, value }))
  const buttons = (card.buttons ?? []).map(button => typeof button === 'string' ? button : button.label)

  return Object.freeze({
    id,
    title: card.title ?? card.kind + ' · ' + card.app,
    mode: 'card',
    metrics: Object.freeze([]),
    card: Object.freeze({
      kind: card.kind,
      app: card.app,
      texts: Object.freeze([...texts, ...extra]),
      buttons: Object.freeze(buttons),
      actions: card.actions ?? 'read-only'
    })
  })
}

/** Byte bound applies to the actual read, including growth after stat. */
export async function readVisualFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<{ path: string; input: unknown }> {
  signal?.throwIfAborted()

  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) {
    throw new Error('Invalid preview size limit.')
  }

  if (!isAbsolute(path) || !path.endsWith('.hvisual.json') || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(path)) {
    throw new Error('Use an absolute path to a prepared .hvisual.json file.')
  }

  const canonical = await realpath(path)

  if (!canonical.endsWith('.hvisual.json')) {
    throw new Error('The resolved file must end in .hvisual.json.')
  }

  const file = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)

  try {
    signal?.throwIfAborted()
    const stat = await file.stat()

    if (!stat.isFile() || stat.size > maxBytes) {
      throw new Error('Preview must be a bounded regular file.')
    }

    const bytes = Buffer.alloc(maxBytes + 1)
    let used = 0

    for (;;) {
      signal?.throwIfAborted()
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, null)
      used += bytesRead

      if (used > maxBytes) {
        throw new Error('Preview exceeds the bundle size limit.')
      }

      if (!bytesRead) {
        break
      }
    }

    signal?.throwIfAborted()

    return {
      path: canonical,
      input: decodeJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)))
    }
  } finally {
    await file.close()
  }
}

/** Read a prepared file using its pinned card schema or the original #457 OpenUI contract. */
export async function readPreparedVisual(path: string, scope: string, signal?: AbortSignal): Promise<PreparedVisual> {
  signal?.throwIfAborted()
  const loaded = await readVisualFile(path, 8 * 1024 * 1024, signal)

  if (record(loaded.input)?.['kind'] === 'hermes.visual.card') {
    const validator = await openCardContract()
    signal?.throwIfAborted()
    const prepared = validator.validatePreparedCard(loaded.input, scope)

    return Object.freeze({
      ...summarizeCard(prepared.card, prepared.id),
      path: loaded.path,
      href: pathToFileURL(loaded.path).href
    })
  }

  // All original OpenUI and intent candidates still use the reviewed donor
  // validator, current source fingerprints and strict session/branch scope.
  const tools = await openUiContract()
  signal?.throwIfAborted()
  const bundle = tools.validateBundle(loaded.input)
  const current = await tools.fingerprints()
  signal?.throwIfAborted()
  tools.assertCurrent(bundle, scope, current)

  return Object.freeze({ ...summarizeVisual(bundle), path: loaded.path, href: pathToFileURL(loaded.path).href })
}
