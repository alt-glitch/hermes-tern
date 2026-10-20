# Scripting Tern blocks from an agent

An agent that runs in a Tern pane can open blocks beside its own, run commands in them, read
what they print, wait for them, and close them. Everything goes through the `tern` CLI; no
plugin or API key is needed. This page is the short version; `tern help` and
`tern COMMAND --help` have every flag (Tern 0.9.5).

## Know where you are

A Tern pane gives its programs these variables:

| Variable | What it is |
| --- | --- |
| `TERN_PANE` | This block's id: the `BLOCK` to split, run in, capture or close. |
| `TERN_WINDOW_KEY` | The window; every `tern` command works on it (or on `--window KEY`). |
| `TERN_PANE_SOCKET`, `TERN_WINDOW_SOCKET`, `TERN_DAEMON_SOCKET` | How `tern` reaches the pane, the window and the session daemon. |

`tern whoami --json` prints the identity chain; outside a pane it says so and exits non-zero,
which is the check to make before scripting anything.

In `hermes tern`, the agent's tools run in the shared Hermes gateway, not in the chat's pane;
the plugin gives every command the agent runs the `TERN_*` variables of the pane that shows
the conversation (`tern_env.py`), so plain `tern …` acts beside the chat. In `hermes chat` or
the Ink TUI in a Tern pane they are inherited as usual.

A `BLOCK` argument is an id (`$TERN_PANE`, or one `tern ls --json` lists), `@focused`, a
title, or a program name; `SESSION/BLOCK` looks in one session.

## Recipes

**Show a file beside you** (a file block: code, Markdown, images, PDFs, 3D models):

```sh
tern open --split right src/app.ts:120      # or --split down, --tab, --preview
tern open --wait notes.md                   # returns when the user closes it
```

**Run something in a new block beside you, and keep its id:**

```sh
id=$(tern split "$TERN_PANE" right --keep-open --cwd "$PWD" -- npm run dev | awk '{print $NF}')
```

`--keep-open` keeps the block after its program exits (by default a block whose program
succeeds closes). `tern new tab [SESSION] [--cwd DIR] [-- COMMAND…]` opens a tab instead.

**Type into a block, press keys, paste:**

```sh
tern run "$id" 'curl -s localhost:3000/health'   # types it and Enter
tern send "$id" keys ctrl+c
tern send "$id" text 'y'
tern send "$id" paste "$(cat payload.json)"
```

**Read what a block shows:**

```sh
tern capture "$id"                    # the screen as text
tern capture "$id" --scrollback       # with history
tern capture "$id" --ansi             # with colors; --html also exists
tern process "$id" --json             # shell pid, foreground pid, argv, cwd
```

**Wait for it:**

```sh
tern wait "$id" --until exit --timeout 600     # exits with the program's status; 124 on timeout
tern wait "$id" --until prompt                 # back at the shell prompt
tern wait "$id" --until idle=3000              # no output for 3 s
```

**Arrange and clean up:**

```sh
tern pip "$id" --corner br            # float it as picture in picture
tern dock "$id" right                 # back into the split
tern move "$id" tab new-tab
tern rename "$id" 'dev server'
tern focus "$id"
tern close "$id"
```

**Drive a browser beside you** (`tern browser --help` lists the ops):

```sh
tern browser '{"op":"open","owner":"'"$TERN_PANE"'","url":"http://localhost:3000"}'
```

**Follow the window:** `tern events [--filter KIND,…]` prints JSON lines for pane spawns,
exits, title and folder changes and bells. There is no output stream: to follow a block's
output, poll `tern capture` (or have the command write a log and read that).

## A worked example

Start a dev server beside the chat, wait until it is up, check it, show the log, stop it:

```sh
tern whoami >/dev/null || { echo 'not in a Tern pane'; exit 1; }
id=$(tern split "$TERN_PANE" down --keep-open -- npm run dev | awk '{print $NF}')
for _ in $(seq 30); do tern capture "$id" | grep -q 'ready on' && break; sleep 1; done
curl -fsS localhost:3000/health
tern capture "$id" --scrollback | tail -20
tern send "$id" keys ctrl+c && tern close "$id"
```

## Going further

- **Native UI of your own** (cards, charts, sheets, keys): a program can describe its view to
  Tern over the Tern Surface Protocol instead of printing cells; this plugin's `frontend/` is
  one, on [`@stencil-hq/tern`](https://www.npmjs.com/package/@stencil-hq/tern).
- **Luau plugins** (`tern plugin --help`; `tern plugin types DIR` writes `tern.d.luau`): command
  lenses that redraw a command's own block as it prints, host events (`command_started`,
  `command_finished`, `pane_exited`), canvas panels, status segments and toasts. Docs at
  [docs.stencil.so/tern](https://docs.stencil.so/tern).
- **Checking it headless:** `tern serve --control PORT` and
  `tern ctl --control PORT run|type|key|shot|tree …` (`tern help dev`); the README's Developing
  section uses this for the plugin's screenshots.
