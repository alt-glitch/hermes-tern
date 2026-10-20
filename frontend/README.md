# ui-tsp — Hermes for Tern

A frontend for Hermes that describes its UI to [Tern](https://stencil.so/tern) over the
Tern Surface Protocol (TSP) instead of painting terminal cells: the transcript, tool calls,
thinking, the composer and every sheet are semantic nodes the terminal lays out, draws and
animates natively. It is a sibling of the Ink TUI (`ui-tui/`) and talks to the same backend,
`tui_gateway`, over the same JSON-RPC contract.

## Running

`hermes` picks it on its own inside Tern (`TERM_PROGRAM=tern`, outside tmux/screen/zellij):

| Switch | Effect |
| --- | --- |
| `hermes --cli` | Classic REPL, as always |
| `HERMES_TERN=0` or `display.tern: false` | Never try the Tern frontend |
| `HERMES_TERN=1` | Try it even where `TERM_PROGRAM` doesn't say Tern (Tern over ssh) |

The frontend asks the terminal for TSP first. A terminal that doesn't answer makes it exit with
code 75, and the launcher runs the Ink TUI in its place (`hermes_cli/main_tui_launch.py`).

## Layout

| Path | What |
| --- | --- |
| `src/entry.ts` | Handshake (`@stencil-hq/tern`), gateway start, `App` |
| `src/app.ts` | The controller: one inline surface, gateway events → transcript, keys → overlay → completion → composer, one coalesced render per change |
| `src/chrome/` | The pane's chrome around the chat: the pills above the composer and their keys, the status strip's notices, the connection's lost and redial lines, and the theme |
| `src/session/` | The open session's settings and name: reasoning effort, title, thoughts, and the views this pane holds on the gateway |
| `src/model.ts`, `src/transcript.ts` | The structured transcript (prompts, turns of thinking/text/tool blocks, notices, panels) folded from gateway events |
| `src/transcript/` | The transcript's parts: compactions, a reload from history, finding calls, todos, subagent rows, and what a message says (Hermes' notices, steers) |
| `src/composer.ts` | The prompt editor's model: text, caret, undo, history, kill ring |
| `src/turn/` | Prompts on their way to the agent: the `Prompt` kinds (typed, the app's, a command's), the router that sends, steers, queues or holds each one through its entry point's gate, `{!cmd}` expansion, the working line's busy state and compaction phase (`Activity`), and the queue behind the turn (held here, and the shared gateway's FIFO with this pane's admissions) with its Edit, Steer and drain |
| `src/draft/` | What the draft carries beside its text: the attached images (clipboard, pasted paths, `/image`, the launcher's `--image`) and those still uploading |
| `src/view/` | Node builders (TSX on the Tern SDK's runtime) for the transcript, tool cards, dock and welcome card; `format.ts` holds how they write text, durations, times and paths |
| `src/tools/` | Tool details: each call's args and result read once (lenient: a field of the wrong type reads as absent) into a variant keyed by its tool, `detail.ts` holding the union and the parse memo |
| `src/view/tools/` | Tool calls as `tool` nodes: `registry.ts` holds one view per tool (its card, step line, action and hub icon), `shell.tsx` wraps a call's card, `cards/` holds one module per card family (terminal, read, edit, search, web, task, ask, eval, connect, apps, images, the small inline ones, the generic fallback) with its tools' views |
| `src/code/` | Code helpers the views share: a file's highlighting language, unified diff hunks and counts |
| `src/view/ui/` | The parts the views share: pills, buttons and the action row, the shimmer and working row, sections headed by a child, facts lists |
| `src/overlay.ts`, `src/overlays/` | Floating sheets: approvals, clarify, masked prompts, completions, pickers |
| `src/prompts/` | The prompt sheets on the overlay stack: their keys, and closing them when the gateway withdraws their questions |
| `src/connections.ts`, `src/connections/` | Connect cards: the card files the plugin writes, and the watcher that keeps each card current and tells the agent |
| `src/palette.ts` | The skin as a Tern program palette (`t`) |

The views speak omp's chat vocabulary (`omp.session`, `omp.user`, `omp.assistant`,
`omp.thinking`, `omp.editor`, `tool` names like `bash`/`read`/`edit`): Tern's chat styles
(Reader, Spine, Console), tool folding and Carly's agent integration are written against those
roles, so Hermes gets them as-is. The `hello` names the program `hermes`, which Tern uses for
its icon, deck tile and branding.

`@tui/*` imports reach the renderer-free modules of `ui-tui/src` (the gateway transport, skins,
history, completion requests); nothing here imports React or Ink.

## Developing

```sh
bun run bundle        # builds dist/entry.js (TSP_OUT=… overrides)
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
