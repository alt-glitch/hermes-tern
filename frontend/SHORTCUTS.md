# Shortcuts, palette and model navigation (Tern frontend)

This port uses the existing Hermes Tern gateway, app ports, native `@stencil-hq/tern` picker and `/model` switch contract. No new persistence or model routing authority is introduced.

## Shortcuts

| Chord | Action |
| --- | --- |
| Alt+A / Alt+J / Alt+P / Alt+S | Agents / background / PRs / sidebar (the plugin's original bindings) |
| Shift+Tab | Cycle reasoning effort |
| Alt+Up / Alt+Enter | Edit oldest queued prompt / steer queued prompt while busy |
| Alt+M | Select model (session-aware native picker) |
| Ctrl+P / Ctrl+Alt+P | Next / previous recent model |
| Alt+K | Native command palette |
| Ctrl+R | Search this profile's previous prompts; Enter fills the draft, Esc leaves it unchanged |
| F1 / Alt+/ | Help and current bindings |
| /palette | Open the command palette |

Ctrl+C, Ctrl+D, Ctrl+V, Esc Esc and the composer's readline keys remain owned by their existing handlers. The overlay stack, modal questions, HUD and completion keep precedence. In particular, Alt+P still opens **pull requests**, not the donor frontend's temporary model selector.

Ctrl+R opens a native fuzzy picker over the same owning-profile `.hermes_history` entries as Up/Down. Newest prompts appear first before a query; matching ranks word starts before scattered subsequences. Enter replaces the composer text without submitting it, and Esc leaves its text, caret and attachments untouched. Recalled shell syntax remains literal.

## Owning-profile bindings

Every refresh captures the **actual adopted session.ref object** and canonical **SessionInfo.profile_name** after synchronous adoption. Supported pinned `config.get` uses BOTH `session_id` and explicit `profile` on `key: 'full'` and optional `key: 'profile'` reads. Hermes `22063fc` otherwise falls back to the connection profile when the sid is absent or reaped; a sid alone is not owner authority.

`config.display.tern_keybindings` maps action IDs in `src/shortcuts/actions.ts` to a chord, array, `null` (default), or `[]` (disabled). When `display.tern_profile_identity === true`, the optional second read returns a **pretty display label**, not canonical authority. Neither that label, HOME basename, nor an ambient profile is an authorized fallback.

Example value of `display.tern_keybindings` in the actual owning profile's config:

```json
{
  "app.palette": ["alt+k"],
  "app.model.select": "alt+m",
  "app.help": null
}
```

If canonical identity is missing, **no preference RPC is made** and built-in shortcuts/composer remain usable. Every reply/readback is fenced by the captured ref's **object identity**, exact canonical profile, and read generation, including A→B→A/reused sid and mid-read profile changes. A new owner never exposes the old map or identity. Invalid, duplicate, overlapping, editor-owned and host-reserved maps are rejected atomically; a current owner retains only its own prior valid map. Ctrl+Shift+P and Ctrl+Shift+K remain Tern host-reserved. No profile settings are written.

## Command palette

`/palette` and Alt+K open a modal Tern `picker`. It searches the existing local command registry and the gateway's `commands.catalog`, excluding hidden/refused commands and duplicates. **Enter** explicitly runs the selected slash command through the existing dispatcher; **Tab** inserts it into the draft without submitting; **Esc** closes without changing the draft. A stale gateway catalog cannot change the new session's palette.

Implemented local commands, including `/palette`, remain searchable. A matching gateway entry appears only once.

## Model navigation

Model cycling reads authorized inventory through the pinned `model.options` with `{ session_id }` (excluding explicitly unauthenticated and unavailable rows). The owning `session.info.model` and `session.info.provider` already project a pending pick while a turn streams; `model.options` has no pending fields or `safe_inventory` flag. Recent accepted selections are local navigation memory (per pane and session, maximum 32); they never change the configured default. If no usable recent shortlist exists, cycling uses the authorized inventory. Every switch uses the existing `switchModel` path and its expensive-model confirmation; no direct model mutation bypasses that guard. The picker flags recent models and the switch path fences late responses from prior sessions.

## OMP verification (not run by this worker)

From the repository root, with `HERMES_SRC` set to the existing Hermes checkout or `.hermes-src` already linked. The pin assertion must pass before running the tests:

```sh
cd frontend
node scripts/hermes-src.mjs
test "$(git -C .hermes-src rev-parse HEAD)" = "$(cat hermes-src.lock)"
bun install --prefer-offline --frozen-lockfile
bun run check
bun run test src/shortcuts/__tests__/binding-preferences.test.ts src/shortcuts/__tests__/help.test.ts src/shortcuts/__tests__/actions.test.ts src/shortcuts/__tests__/model-cycle.test.ts src/shortcuts/__tests__/palette.test.ts src/__tests__/keys.test.ts src/__tests__/golden.test.ts --reporter=verbose
bun run bundle
python3 -m py_compile src/shortcuts/__tests__/fixtures/native-keybindings-profile-core.py
```

Also manually verify Tern key input (modified F1, Alt+/ and Alt+K), Enter vs Tab in the palette, model confirmation on both gateway modes, reconnect/session replacement while reads are outstanding, and canonical and private gateway `config.get` full/profile behavior.

### Provenance

Adapted from the user's Hermes fork `kvnloo/hermes-agent` at `preview/tern-frontend/ui-tsp/src/actions.ts`, `binding-preferences.ts`, `model-cycle.ts`, `model-recents.ts`, and `SHORTCUTS.md`, and integrated with this plugin's existing `frontend/src/draft/keys.ts`, `overlays/models.tsx`, `overlays/help.tsx`, `commands/local.ts` and Tern SDK. The underlying Tern / OMP interaction conventions originate with Can Bölük / Stencil contributors.
