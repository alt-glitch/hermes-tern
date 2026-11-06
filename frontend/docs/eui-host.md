# Host-owned ephemeral cards

The host publication API extends the renderer introduced in PR #208. It uses
the same EuiNode-to-Tern conversion, scoped kit stylesheet and native surface.
Ordinary `ephemeral-ui` fences still select demo cards. A fence cannot register
an operation, address a host publication, or restore an approval from history.

## Publishing a card

Trusted frontend code calls `app.eui.host.publish(data, operation?)`. It appends
a host-owned panel to the current transcript and returns a handle with its
`id`, current `revision`, `update(data, operation?)` and `revoke()`.

The data contract is:

| Field | Contract |
| --- | --- |
| `kind` | A kind in the pinned card.v0 catalog |
| `app` | A bounded app identifier, such as `glide` |
| `title` | Required plain text, up to 200 characters |
| `summary` | Optional plain text, up to 2,048 characters |
| `rows` | At most 32 label/value rows; labels up to 80 characters, string values up to 2,048 |
| Row values | Strings, finite numbers or booleans; zero and false are preserved |
| `approval` | Only on `approve`: a label up to 80 characters and an operation description up to 2,048 |

Unknown fields are rejected. The complete normalized snapshot is limited to
16 KiB of UTF-8 JSON. Publication reconstructs and freezes every displayed
field, including nested rows and approval text. Rendering treats values as
literal text. There are no input-defined templates, styles, URLs or executable
fields. The host layout is a title, optional summary, rows and, for an approval,
the exact description followed by one native button.

An approval requires a separate trusted function; a read-only card rejects
one. The function receives the captured session ID, publication revision,
immutable data and an AbortSignal. It must capture the reviewed operation's
arguments, use this captured session rather than a later current session,
and honor cancellation before any later asynchronous side effect. Host code
remains responsible for truthful descriptions and the operation's own backend
authorization. This API does not grant new gateway capabilities.

## One-use approval lifecycle

A grant belongs to the panel object, session/profile owner generation,
transcript lifetime and monotonically increasing publication revision.
It is never looked up by text supplied in an assistant answer. The native
button's path includes the revision, and its callback closes over that exact
publication. This rejects both a saved callback and an old queued wire event
after an update, including an update with unchanged kind and app.

Only an explicit tap while the pane is visible and no modal or session switch
owns input can invoke the function. The grant is consumed synchronously before
the function runs. Reentrant taps, double taps, later replay, thrown errors and
rejected promises cannot restore it. Success and failure update only the
publication that started the operation. Retrying requires a freshly reviewed
publication.

Replacement, explicit revocation, eviction, session/profile change, transcript
reload, gateway loss and disposal abort the operation's signal and remove its
grant. At most 48 publications remain active; eviction leaves an inert
unavailable panel. Theme changes do not recreate or rearm approvals. Restored
transcripts never restore callbacks. Async cancellation is cooperative: work
already performed before cancellation cannot be undone by the renderer.

## Offline rendering

The sandbox fetch facade reads only these named local data files:
`apps.json`, `themes.json`, `trace-fixture.json`,
`intent-snapshot.json` and `ops-fixture.json`, under the packaged data
directory. It rejects remote URLs, absolute paths, traversal, query strings and
unknown asset names before filesystem lookup. It never calls network fetch.

Only the public app and theme catalogs are shipped. Trace, intent and ops
captures remain excluded by the vendor policy. If absent, the existing kit
shows its explicit unavailable message; it does not download captures or
infer a result. Host cards render supplied data without running the demo kit,
fetching fixtures or invoking operations during render.

## Verification

The authoring worker did not execute tests. Exact-head CI status belongs in
the PR. The added Vitest tests use synthetic values and the repository's
existing app/SDK fakes:

- `src/__tests__/euiHostCards.test.ts`: data bounds, immutable values,
  literal rendering, one-use execution, failure, replacement, ownership,
  eviction and cancellation.
- `src/__tests__/euiHostApp.test.ts`: actual native wire dispatch with and
  without retained rows, stale events before/after repaint, modal/switch
  gates, adoption/reload/transport loss and disposal.
- `src/__tests__/euiOffline.test.ts`: all pinned kinds with networking
  forbidden, unavailable capture states, and local asset-path restrictions.

Run the focused suites alongside the original `euiCards.test.ts` and
`euiApp.test.ts`, then the repository's `bun run check` and `bun run bundle`.
Do not commit the generated bundle. A real native Tern smoke test is still
required before promotion.

This is the host data/approval prerequisite for #209. The z0 CLI adapter,
onboarding steps and the complete /glide flow are separate work.
