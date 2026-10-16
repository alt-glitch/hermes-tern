// The model picker (`/model`, the composer's model chip): every configured
// provider's models in one `picker` sheet like omp's (search, a provider
// scope column, facts, a preview pane, the current model checked), switching
// the session's model through `config.set` as the Ink TUI's picker does.

import type { ConfigSetResult, ModelOptionProvider, ModelOptionsResult } from '@hermes/shared/gateway-events'
import { modelSearchText } from '@hermes/shared/model-search-text'
import type { JSX, Key, KvItem, PickerColumn, PickerGroup, PickerItem, PickerScope } from '@stencil-hq/tern'
import { providerDisplayNames } from '@tui/domain/providers.js'

import type { App } from '../app.js'
import type { Overlay } from '../overlay.js'

import { editQuery, hitRuns, moveSelection, rank } from './search.js'

const KEY = 'models'
const ALL = 'all'

interface Row {
  id: string
  provider: ModelOptionProvider
  providerName: string
  model: string
}

interface Confirm {
  row: Row
  text: string
}

/** `config.set model` for `value` (`<model> [--provider <slug>] [--session|--global]`); reports the switch in the transcript unless it needs a confirmation. */
export async function switchModel(app: App, value: string, confirmed = false): Promise<ConfigSetResult> {
  const r = await app.gw.request<ConfigSetResult>('config.set', {
    confirm_expensive_model: confirmed,
    key: 'model',
    session_id: app.sid,
    value
  })

  if (r.confirm_required) {
    return r
  }

  const model = typeof r.value === 'string' ? r.value : ''

  if (model) {
    app.info = { ...app.info, model }
    app.transcript.notice(r.deferred ? `Model switches to ${model} from the next turn.` : `Switched to ${model}.`)
  }

  if (r.warning) {
    app.transcript.notice(r.warning, 'warning')
  }

  app.changed()

  return r
}

/** Opens the model picker over the session. */
export function openModelPicker(app: App) {
  let state: 'loading' | 'ready' | 'error' = 'loading'
  let message = ''
  let rows: Row[] = []
  let providers: { provider: ModelOptionProvider; name: string }[] = []
  let current = ''
  let query = ''
  let scope = ALL
  let selected: string | undefined
  let global = false
  let confirm: Confirm | null = null
  let busy = false
  /** The ids shown, in order, for ↑/↓. */
  let shown: string[] = []

  const load = async () => {
    state = 'loading'
    app.changed()

    try {
      const r = await app.gw.request<ModelOptionsResult>('model.options', app.sid ? { session_id: app.sid } : {})
      const list = r.providers ?? []
      const names = providerDisplayNames(list)
      providers = list.map((provider, i) => ({ name: names[i] ?? provider.name, provider }))
      rows = providers.flatMap(({ provider, name }) =>
        (provider.models ?? []).map(model => ({
          id: `${provider.slug}\t${model}`,
          model,
          provider,
          providerName: name
        }))
      )
      const currentProvider = list.find(p => p.is_current)?.slug ?? r.provider ?? ''
      current =
        rows.find(row => row.model === r.model && row.provider.slug === currentProvider)?.id ??
        rows.find(row => row.model === r.model)?.id ??
        ''
      selected = current || rows[0]?.id
      state = 'ready'
    } catch (error) {
      state = 'error'
      message = error instanceof Error ? error.message : String(error)
    }

    app.changed()
  }

  const choose = async (id: string | undefined, confirmed = false) => {
    const row = rows.find(r => r.id === id)

    if (!row || busy) {
      return
    }

    busy = true

    try {
      const r = await switchModel(
        app,
        `${row.model} --provider ${row.provider.slug} ${global ? '--global' : '--session'}`,
        confirmed
      )

      if (r.confirm_required) {
        confirm = { row, text: r.confirm_message || r.warning || `${row.model} is expensive. Switch anyway?` }
      } else {
        app.close(overlay)
      }
    } catch (error) {
      app.transcript.notice(error instanceof Error ? error.message : String(error), 'error')
      app.close(overlay)
    }

    busy = false
    app.changed()
  }

  const view = () => {
    const inScope = scope === ALL ? rows : rows.filter(r => `provider:${r.provider.slug}` === scope)
    const ranked = rank(inScope, query, r => `${modelSearchText(r.model)} ${r.providerName} ${r.provider.slug}`)
    const hits: Record<string, [number, number][]> = {}
    const order: (string | PickerGroup)[] = []

    // The current provider's group leads, then the backend's order.
    const groups = [...providers].sort(
      (a, b) => Number(Boolean(b.provider.is_current)) - Number(Boolean(a.provider.is_current))
    )

    for (const { provider, name } of groups) {
      const mine = ranked.filter(r => r.item.provider === provider)

      if (!mine.length) {
        continue
      }

      if (scope === ALL) {
        order.push({ count: mine.length, group: provider.slug, label: name })
      }

      for (const { item, positions } of mine) {
        order.push(item.id)

        if (positions.length) {
          hits[item.id] = hitRuns(positions, item.model.length)
        }
      }
    }

    shown = order.filter(o => typeof o === 'string')

    if (!selected || !shown.includes(selected)) {
      selected = shown[0]
    }

    return { hits, order }
  }

  const overlay: Overlay = {
    key: KEY,
    modal: true,
    node: () => {
      const { hits, order } = view()
      const priced = rows.some(r => r.provider.pricing?.[r.model])
      const columns: PickerColumn[] = priced ? [{ format: 'price', head: '$/M', id: 'price', priority: 2 }] : []

      const scopes: PickerScope[] = [
        { count: rows.length, icon: 'list', id: ALL, label: 'All models' },
        ...providers.map(({ provider, name }) => ({
          count: provider.models?.length ?? 0,
          dot: provider.warning ? ('warning' as const) : undefined,
          group: 'Providers',
          id: `provider:${provider.slug}`,
          label: name,
          mark: { seed: provider.slug, text: name }
        }))
      ]

      const row = rows.find(r => r.id === selected)

      return (
        <picker
          actions={[
            { id: 'global', keys: ['ctrl+g'], label: 'Save as default', on: global },
            { end: true, id: 'close', keys: ['esc'], label: 'Close' },
            { id: 'use', keys: ['enter'], label: 'Switch', primary: true }
          ]}
          columns={columns}
          confirm={confirm ? { act: 'confirm', label: 'Switch anyway', text: confirm.text } : undefined}
          current={current ? [current] : []}
          empty={query ? undefined : 'No models in this scope'}
          hits={hits}
          icon="cpu"
          items={rows.map(itemOf)}
          key={KEY}
          layout="rows"
          message={state === 'error' ? message : undefined}
          noun="models"
          onAction={{
            cancel: () => {
              confirm = null
              app.changed()
            },
            clear: () => {
              query = ''
              app.changed()
            },
            close: () => app.close(overlay),
            confirm: () => void choose(confirm?.row.id, true),
            global: () => {
              global = !global
              app.changed()
            },
            retry: () => void load(),
            scope: ev => {
              scope = ev.value ?? ALL
              app.changed()
            },
            use: () => void choose(selected)
          }}
          onActivate={ev => void choose(ev.item)}
          onSelect={ev => {
            selected = ev.item
            confirm = null
            app.changed()
          }}
          order={order}
          placeholder="Search models…"
          preview="side"
          query={query}
          scope={scope}
          scopes={scopes}
          selected={selected}
          size="lg"
          state={state}
          title="Models"
          total={rows.length}
        >
          {row ? preview(row, row.id === current) : null}
        </picker>
      )
    },
    onKey: (k: Key) => {
      if (confirm) {
        if (k.name === 'enter' || k.name === 'y') {
          void choose(confirm.row.id, true)
        } else if (k.name === 'escape' || k.name === 'n') {
          confirm = null
        }

        return true
      }

      if (k.name === 'escape') {
        app.close(overlay)

        return true
      }

      if (k.name === 'enter') {
        void choose(selected)

        return true
      }

      if (k.ctrl && k.name === 'g') {
        global = !global

        return true
      }

      if (k.name === 'tab') {
        const ids = [ALL, ...providers.map(p => `provider:${p.provider.slug}`)]
        scope = ids[(ids.indexOf(scope) + (k.shift ? ids.length - 1 : 1)) % ids.length] ?? ALL

        return true
      }

      const moved = moveSelection(k, shown, selected)

      if (moved !== undefined) {
        selected = moved

        return true
      }

      const edited = editQuery(k, query)

      if (edited !== undefined) {
        query = edited
      }

      return true
    }
  }

  app.open(overlay)
  void load()
}

function itemOf(row: Row): PickerItem {
  const price = row.provider.pricing?.[row.model]
  const caps = row.provider.capabilities?.[row.model]
  const free = Boolean(price?.free)
  const unavailable = row.provider.unavailable_models?.includes(row.model)

  return {
    badges: [
      ...(free ? [{ text: 'free', tone: 'success' as const }] : []),
      ...(caps?.ultrafast
        ? [{ text: 'ultrafast', tone: 'info' as const }]
        : caps?.fast
          ? [{ text: 'fast', tone: 'info' as const }]
          : [])
    ],
    disabled: unavailable ? `${row.providerName} doesn't offer ${row.model} on this plan` : undefined,
    facts:
      price && !free && price.input
        ? { price: `${price.input}·${price.output}` }
        : free
          ? { price: 'free' }
          : undefined,
    id: row.id,
    label: row.model,
    mono: true,
    title: `${row.providerName} · ${row.model}`
  }
}

function preview(row: Row, isCurrent: boolean): JSX.Element[] {
  const caps = row.provider.capabilities?.[row.model]
  const price = row.provider.pricing?.[row.model]

  const facts: KvItem[] = [
    { k: [{ t: 'Provider' }], v: row.providerName },
    ...(price && (price.input || price.free)
      ? [
          {
            k: [{ t: 'Price' }],
            v: [{ s: 'mono', t: price.free ? 'free' : `${price.input} in · ${price.output} out` }]
          }
        ]
      : []),
    ...(caps
      ? [
          { k: [{ t: 'Reasoning' }], v: [{ s: 'mono', t: caps.reasoning ? 'yes' : 'no' }] },
          { k: [{ t: 'Fast mode' }], v: [{ s: 'mono', t: caps.fast || caps.ultrafast ? 'yes' : 'no' }] }
        ]
      : []),
    ...(row.provider.api_url ? [{ k: [{ t: 'Endpoint' }], v: [{ s: 'mono dim', t: row.provider.api_url }] }] : [])
  ]

  const short = row.model.split('/').at(-1) ?? row.model

  return [
    <text key="title" role="omp.picker.title" text={short} />,
    <text
      key="id"
      spans={[{ s: 'mono', t: `${row.provider.slug}/${row.model}` }]}
      title={row.model}
      truncate="middle"
    />,
    <row gap="xs" key="badges" wrap>
      {isCurrent ? <badge key="current" text="current" tone="success" /> : null}
      {caps?.reasoning ? <badge key="reasoning" text="reasoning" /> : null}
      {caps?.fast || caps?.ultrafast ? (
        <badge key="fast" text={caps.ultrafast ? 'ultrafast' : 'fast'} tone="info" />
      ) : null}
      {price?.free ? <badge key="free" text="free" tone="success" /> : null}
    </row>,
    <kv items={facts} key="facts" />,
    ...(row.provider.warning
      ? [<text key="warning" spans={[{ s: 'warning', t: row.provider.warning }]} wrap="word" />]
      : [])
  ]
}
