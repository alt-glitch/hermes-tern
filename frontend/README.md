# hermes-tern frontend

The chat UI that `hermes tern` runs. It describes the UI to [Tern](https://stencil.so/tern) over
the Tern Surface Protocol (TSP) instead of painting terminal cells: the transcript, tool calls,
thinking, the composer and every sheet are semantic nodes that the terminal lays out, draws and
animates natively. It is a sibling of Hermes' Ink TUI (`ui-tui/`), and it talks to the same
backend, `tui_gateway`, over the same JSON-RPC contract.

## Running

The plugin's `hermes tern` command (`../__init__.py`) runs `hermes chat --tui` with
`HERMES_TUI_DIR` pointing here, so Hermes' launcher starts `dist/entry.js`. The frontend asks the
terminal for TSP first. A terminal that does not answer makes it exit with code 75, and
`hermes tern` runs the Ink TUI in its place.

```mermaid
flowchart LR
  GW[gateway events] --> L[session/lifecycle] --> D[gateway/dispatch] --> S[(stores)]
  K[keys] --> KR[draft/keys] --> A[app/actions] --> R[turn/router] -->|wire/rpc| GW
  S --> F[app/frame] --> T[Tern surface]
```

## Layout

| Path | What |
| --- | --- |
| `src/entry.ts` | Handshake (`@stencil-hq/tern`), gateway start, `App` |
| `src/app/` | The composition root: `chat.ts` (`App`: one inline surface, gateway events → transcript, keys → overlay → completion → composer; its ports, run and quit), `stores.ts` (every store, made in dependency order and wired together), `actions.ts` (what the user starts, bound once), `frame.ts` (one coalesced render per change), `ports.ts` (what App lends the modules it drives) |
| `src/chrome/` | The pane's chrome around the chat: the pills above the composer and their keys, the status strip's notices, the backend's own failures, the connection's lost and redial lines, the session sidebar (`sidebar.tsx`: branch, PRs, changes), and the theme with its Tern program palette (`t`) |
| `src/session/` | The open session: its state (ids, info, usage, busy-input mode, and the tickets awaited work checks), its lifecycle (the first session, new, resume, reattach, switches and the requests held across one), the ordered steps of an adopt, the views this pane holds on the gateway, which gateway traffic belongs to it (`flow.ts`), its standing /goal and /loop, and its settings and name: reasoning effort, fast mode, title, thoughts |
| `src/model.ts` | The structured transcript's types (prompts, turns of thinking/text/tool blocks, notices, panels) |
| `src/transcript/` | The transcript folded from gateway events (`store.ts`) and its parts: compactions, a reload from history, finding calls, todos, subagent rows, what a stored prompt carried, and what a message says (Hermes' notices, steers) |
| `src/turn/` | Prompts on their way to the agent: the `Prompt` kinds (typed, the app's, a command's), the router that sends, steers, queues or holds each one through its entry point's gate, `{!cmd}` expansion, the turn's controls (interrupt, steer, redirect), the working line's busy state and compaction phase (`Activity`), and the queue behind the turn (held here, and the shared gateway's FIFO with this pane's admissions) with its Edit, Steer and drain |
| `src/draft/` | The draft: the prompt editor's model (`composer.ts`: text, caret, undo, history, kill ring), its live Markdown, its keys, and what it carries beside its text: the attached images (clipboard, pasted paths, `/image`, the launcher's `--image`) and those still uploading |
| `src/commands/` | Slash commands: those this frontend runs itself (`local.ts`), the turn controls and session commands the shared gateway serves through their own RPCs (`control.ts`, `session.ts`), those its `slash.exec` refuses (`refused.ts`), a typed name's resolution (`resolve.ts`) and the `slash.exec` path (`slash.ts`) |
| `src/view/` | Node builders (TSX on the Tern SDK's runtime) for the transcript, tool cards, dock and welcome card; `format.ts` holds how they write text, durations, times and paths, and `workLogModel.ts` how a turn's work groups and its steps and working line read. Only the modules that draw import it (docs/conventions.md) |
| `src/tools/` | Tool details: each call's args and result read once (lenient: a field of the wrong type reads as absent) into a variant keyed by its tool, `detail.ts` holding the union and the parse memo; Tool Search's `tool_call` bridge unpacked (`bridge.ts`) |
| `src/view/tools/` | Tool calls as `tool` nodes: `registry.ts` holds one view per tool (its card, step line, action and hub icon), `shell.tsx` wraps a call's card, `cards/` holds one module per card family (terminal, read, edit, search, web, task, ask, eval, connect, apps, images, the small inline ones, the generic fallback) with its tools' views |
| `src/code/` | Code helpers the views share: a file's highlighting language, unified diff hunks and counts |
| `src/view/ui/` | The parts the views share: pills, buttons and the action row, the shimmer and working row, sections headed by a child, facts lists |
| `src/overlays/` | Floating sheets (`overlay.ts` is their contract): approvals, clarify, masked prompts, completions, pickers |
| `src/prompts/` | The prompt sheets on the overlay stack: their keys, and closing them when the gateway withdraws their questions |
| `src/connections/` | Connect cards: the card files the plugin writes (`cards.ts`), and the watcher that keeps each card current and tells the agent |
| `src/hermes/` | Hermes' own runtime and files: the gateway client, its `state.db` (the session index, the compaction boundaries), paths, shell, history |

The views speak omp's chat vocabulary (`omp.session`, `omp.user`, `omp.assistant`,
`omp.thinking`, `omp.editor`, `tool` names like `bash`/`read`/`edit`): Tern's chat styles
(Reader, Spine, Console), tool folding and Carly's agent integration are written against those
roles, so Hermes gets them as-is. The `hello` names the program `hermes`, which Tern uses for
its icon, deck tile and branding.

`@tui/*` imports reach the renderer-free modules of `ui-tui/src` (the gateway transport, skins,
history, completion requests); nothing here imports React or Ink.

## Developing

```sh
bun run bundle        # builds dist/entry.js for local runs (TSP_OUT=… overrides); main's CI commits it
bun run typecheck
bun run test          # vitest
bun run lint          # eslint, held to scripts/lint-legacy.json (docs/conventions.md)
bun run check         # the Hermes pin, typecheck, tests, lint and the ratchets
bun run bundle:report # bytes per src/ module against a saved baseline (--save records one)
```

`hermes-src.lock` holds the Hermes commit this frontend builds against. `bun run check` warns
when `.hermes-src` points somewhere else (`hermes update` moves it); a Hermes bump rewrites the
lock in its own commit.

`TERN_TSP_RECORD=<file>` records every TSP message as JSONL; Tern's `surface-play` replays it.
`HERMES_TERN_EVENT_LOG=<file>` writes every gateway event, and every server request as
`{"request": …}`, one JSON line each: the format of the golden replays' fixtures
(`src/__tests__/fixtures/`), which `golden.test.ts` feeds through the app between scripted keys.

The Tern SDK is [`@stencil-hq/tern`](https://www.npmjs.com/package/@stencil-hq/tern) from npm
([stencil-hq/tern-sdk](https://github.com/stencil-hq/tern-sdk)), pinned like every other dependency.
