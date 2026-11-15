<h1 align="center">hermes-tern</h1>

<p align="center">
  <b><a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a>, drawn natively by <a href="https://stencil.so/tern">Tern</a>.</b><br>
  The transcript, tool cards, approvals, subagents and pull requests are real Tern UI, not text in a terminal.
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Hermes Agent newer than 0.23.0" src="https://img.shields.io/badge/hermes--agent-%3E0.23.0-6f42c1">
  <img alt="Tern 0.9.5" src="https://img.shields.io/badge/tern-0.9.5-2b7a78">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#the-chat">The chat</a> ·
  <a href="#background-processes">Background processes</a> ·
  <a href="#pull-requests">Pull requests</a> ·
  <a href="#security-and-privacy">Security</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#development">Development</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark.png">
    <img alt="hermes tern: a chat beside a pull request docked at the pane's edge" src="docs/images/hero-light.png">
  </picture>
</p>

## Install

```sh
hermes plugins install hermes-tern            # from the plugin catalog, once listed
hermes plugins install alt-glitch/hermes-tern # or from GitHub
```

You need a Hermes Agent newer than the 0.23.0 release (run `hermes update`) and [Tern](https://stencil.so/tern). The plugin is built and tested on Tern 0.9.5. When the pane connects, it checks what the gateway supports. On a Hermes that is too old it opens no session and says to run `hermes update`.

Then, in a Tern pane:

```sh
hermes tern        # the chat, drawn by Tern
hermes tern -c     # also: -r ID, -m MODEL, -q QUERY, --image PATH, -s SKILL, --yolo, … (`hermes tern -h`)
hermes tern --new  # a new session, where the pane would resume its last one
```

A pane remembers its conversation. If `hermes tern` dies in a pane (a crash, a kill, or a restart of Tern's session daemon), the next `hermes tern` in that pane resumes the conversation and says so. It does this only when you give no session flag, the shell is in the same folder (or the session's folder), and no other live pane shows that conversation. If you quit (Ctrl+D, Ctrl+C twice or `/quit`), the next `hermes tern` starts a new session.

> [!TIP]
> To open Hermes in Tern's agent pane, set `agent_command` in Tern's settings to `hermes tern`.

`hermes tern` describes the chat to Tern over the Tern Surface Protocol (TSP). Tern then draws it with its own components: Markdown, folds, diffs, sheets, asides and keys. If no TSP answer comes back, `hermes tern` says so and exits. This happens outside Tern, and inside tmux, screen or zellij. Use `hermes chat` there.

### What the plugin adds

| | |
| --- | --- |
| `hermes tern` | The chat in this plugin's Tern frontend. It runs in a Tern pane only |
| `link_pull_request`, `unlink_pull_request`, `list_pull_requests` | Tools: the PRs a conversation works on, shown above the composer |
| Plugin RPC methods (`ctx.register_rpc`) | The pane's own calls to the plugin: which session it shows, a conversation's linked PRs, a chart's rules, a check of a reply's figures |
| Per-session environment (`ctx.register_session_env`) | The agent's shell commands run with the chat's `TERN_PANE`, so `tern open` works beside the chat |
| `tern_charts` auxiliary task | Writes the rules behind a background process's live chart (`auxiliary.tern_charts` picks its model) |
| System prompt sections | Tell the agent to link the PRs it opens, and (only in a session `hermes tern` started) what Tern draws in a reply |

## The chat

A turn shows what the agent does while it works: its reasoning, short notes, and its tool calls, grouped into one line per run ("Ran 3 commands"). A todo list stays live in the transcript and in the status line. When the turn ends, the work folds into "Worked for 9.5s", and the answer stays in view.

<table>
  <tr>
    <td width="50%"><img alt="A turn in progress with a live todo list" src="docs/images/transcript.png"></td>
    <td width="50%"><img alt="An approval sheet for a flagged command, with one button per answer" src="docs/images/approval.png"></td>
  </tr>
  <tr>
    <td><b>Live work.</b> Tool runs fold to one line, and the todo list ticks as it goes.</td>
    <td><b>Approvals.</b> A flagged command asks first. There is one button for each answer, and long commands wrap.</td>
  </tr>
  <tr>
    <td><img alt="Three delegated subagents running in the background" src="docs/images/subagents.png"></td>
    <td><img alt="The session sidebar docked at the pane's edge" src="docs/images/sidebar.png"></td>
  </tr>
  <tr>
    <td><b>Subagents.</b> A delegated batch is one card, with one row per agent: its model and its tool count.</td>
    <td><b>Sidebar.</b> The branch, the session's pull requests and the changed files.</td>
  </tr>
</table>

### Keys and commands

| Key | Does |
| --- | --- |
| <kbd>Enter</kbd> · <kbd>Shift</kbd>+<kbd>Enter</kbd> | Send · new line |
| <kbd>Alt</kbd>+<kbd>Enter</kbd> | Steer: send into the running turn |
| <kbd>Alt</kbd>+<kbd>↑</kbd> | Edit a queued prompt |
| <kbd>Esc</kbd> <kbd>Esc</kbd> · <kbd>Ctrl</kbd>+<kbd>C</kbd> | Stop the turn |
| <kbd>Shift</kbd>+<kbd>Tab</kbd> | Reasoning effort |
| <kbd>Alt</kbd>+<kbd>S</kbd> · <kbd>Alt</kbd>+<kbd>P</kbd> · <kbd>Alt</kbd>+<kbd>J</kbd> · <kbd>Alt</kbd>+<kbd>A</kbd> | Sidebar · pull requests · background processes · subagents |
| <kbd>Ctrl</kbd>+<kbd>V</kbd> | Paste an image |

| Command | Does |
| --- | --- |
| `/model`, `/effort` | Pick the model and the reasoning effort (also the chips on the composer) |
| `/sessions` | Search and resume a session from this project, or from any folder. <kbd>→</kbd> browses the selected conversation; <kbd>Alt</kbd>+<kbd>C</kbd> copies its id |
| `/tree` | This conversation's branches as a tree; open one |
| `/ps` | Background processes and cron jobs |
| `/agents` | Subagents |
| `/changes` | The working tree's diff |
| `/prs [N]` | Pull requests, or PR #N |
| `/theme` | Paint the chat in Tern's colors, Nous colors or the Hermes skin |

### Figures

Tern draws more than Markdown in a reply: ```` ```mermaid ```` diagrams (through merman, the Rust
port of Mermaid, so 35 kinds from flowcharts to Wardley maps), ```` ```svg ```` figures in the
theme's colors, TeX math, 3D fences (` ```stl `, ` ```obj `), callouts and links to files at a line.
The plugin tells the agent so in sessions `hermes tern` started, and a line `MEDIA:/path` in a reply
shows that file (an image, PDF, video, audio or 3D model) in Tern's viewer.

After a turn, the plugin checks the reply's diagrams with merman and its svg figures against Tern's
rules (`figure_check.py`, which fetches merman through Hermes' `uv` on first use). When one would
not render, it asks the agent once to send it again, with the error and the line.

<img alt="A reply with a broken diagram, math, an svg figure and an image, then the fixed diagram" src="docs/images/figures.png" width="600">

## Background processes

The agent can run a command in the background (`terminal(background=true)`). Such a command gets a live chart, as in omp.

1. After 15 s of output, Hermes' auxiliary model reads the command and samples of its output, once. It writes rules that pull numbers out of each line: throughput, latency, loss, tests passed, or progress toward a total that the command states. If nothing is worth charting, it declines.
2. From then on, the plugin applies the rules to each new line itself. It makes no more model calls.
3. A command that writes its output to a log file (`> /tmp/run.log 2>&1`, `| tee run.log`) is charted from that file.
4. After a decline, the plugin asks again when the output has doubled. A job often prints setup lines first and its numbers later.

<p align="center"><img alt="The shells pill with a job's figure and mini chart, its hover card above a column chart with a dashed goal line" src="docs/images/job-chart.png" width="600"></p>

| Where | What it shows |
| --- | --- |
| The shells pill | The newest figure and a mini chart. Hover over it to see a tile for each running process. |
| The background terminal card | The primary chart, under the process's live line |
| A `process_manage` wait or poll | The process's tile, in view while the agent waits |
| The Background sheet (`/ps`, <kbd>Alt</kbd>+<kbd>J</kbd>) | The whole chart, above the output |

Goals that the command states draw as dashed lines. The plugin keeps each process's rules in `$HERMES_HOME/plugin-data/hermes-tern/charts/`. So another pane on the session, or a resumed session, charts the process without a new model call.

- **Model:** `auxiliary.tern_charts` in `config.yaml` (or Hermes' model picker) chooses the model. Use a cheap one.
- **Secrets:** Hermes redacts secrets in the samples before they leave.
- **Turn charts off:** set `"jobCharts": false` in `$HERMES_HOME/hermes-tern/settings.json`.

## Pull requests

The agent links every PR that it opens or works on, as T3 Code does. The pill above the composer counts them. Click it (or press <kbd>Alt</kbd>+<kbd>P</kbd>) to open a tray with each PR's state and age.

<p align="center"><img alt="The PR tray above the composer" src="docs/images/pr-tray.png" width="760"></p>

Pick a PR, and it docks at the chat's right edge, beside the conversation. The chat gets narrower but keeps the keys, so you can continue to talk to the agent while the PR stays in view. `/prs 22` opens #22 directly.

<table>
  <tr>
    <td width="42%"><img alt="The Files tab: Tern's own edit cards and diffs" src="docs/images/pr-files.png"></td>
    <td>

**Drawn as GitHub draws it.** PR bodies and comments go through the same pipeline as T3 Code's PR panel (`remark-gfm`, `rehype-raw`, GitHub's sanitize schema). `<details>` become folds, bot badges become links, and HTML comments are removed. Tables, task lists, alerts and mermaid diagrams draw natively. `#123` and `@login` are links.

**Three tabs, as on GitHub.**

- **Conversation:** the description, then every comment, review, review thread and commit, in order.
- **Checks:** failing and running checks are open; passed and skipped checks are folded.
- **Files:** each file is Tern's own edit card with its diff, highlighted, and folded around the hunks.

**Actions.** Merge and close (both ask first), mark ready for review, update the branch, re-run failed jobs, copy `gh pr checkout N`, and open on GitHub.

The aside is as wide as Tern's Settings sheet. To resize it, drag that sheet's edge (<kbd>⌘</kbd>+<kbd>,</kbd>).

</td>
  </tr>
</table>

The links are kept for each conversation in `$HERMES_HOME/plugin-data/hermes-tern/pull-requests.json`, so they survive compression and resume. The list also shows two kinds of PR that the agent did not link:

- the PR of the session's branch;
- the other layers of a GitHub stack that a listed PR is part of.

The plugin reads PRs from GitHub with your own token, which Hermes provides. Set it once:

```sh
hermes config set GITHUB_TOKEN "$(gh auth token)"
```

The plugin never reads another tool's login.

The plugin reads PRs from github.com, and from a GitHub Enterprise Server only when you list its host. A PR link's host comes from the agent, so the plugin refuses every other host and sends a token to none of them:

```sh
hermes config set plugins.entries.hermes-tern.settings.enterprise_hosts '["github.mycompany.com"]'
hermes config set GITHUB_ENTERPRISE_TOKEN <token>
```

Open a new pane after you change the list. `GITHUB_TOKEN` goes only to `api.github.com`, and `GITHUB_ENTERPRISE_TOKEN` goes only to the hosts you list. Write a host with a port (`github.mycompany.com:8443`) only if its web address has one. A link that an older version stored for another host stays on the list, marked as not read, until you unlink it.

## Security and privacy

This section lists what the plugin does beyond drawing the chat, so you can decide before you install it.

| | |
| --- | --- |
| **Network** | GitHub's API, with the token that Hermes gives it: `GITHUB_TOKEN` to `api.github.com` only, and `GITHUB_ENTERPRISE_TOKEN` only to the hosts in `enterprise_hosts`. Redirects to another host are not followed. It is used for the pull request view and for the actions you click; merge and close ask first. The job charts send the command and samples of a background process's output to your own auxiliary model (`auxiliary.tern_charts`), once per process, after Hermes redacts them. The first figure check downloads the `merman` package (version 0.8.0) from your Python package index through Hermes' `uv`; later checks use uv's cache. Nothing else. **No telemetry.** |
| **Commands** | The agent's shell commands get the chat's Tern pane variables (`TERN_PANE` and the window's) in their environment, through Hermes' per-session environment, in sessions that a Tern pane shows. The command itself is not changed: the approval sheet shows exactly what runs. `!cmd` and `{!cmd}` in the composer run through Hermes' own `shell.exec`, so its dangerous-command refusal applies. They run only when you type them: a pasted `{!cmd}` never runs. The composer's `/` commands are Hermes' own. |
| **Processes** | `hermes tern` runs the frontend with Node, and the frontend runs `hermes gateway attach` each time it connects. A pasted image is read with `osascript` on macOS and with `hermes clipboard image` elsewhere. Opening the sidebar, or a file beside the chat, runs Tern's own `tern` CLI. With `-w`, Hermes' own worktree functions run `git` in the repository. After a reply that has a mermaid or svg figure, the gateway runs `figure_check.py` in a `uv` subprocess, one at a time, with the figure's text on its standard input. |
| **Reads outside its data** | Hermes' session database, read-only, from the plugin's Python half through Hermes' own `hermes_state` API: a conversation's compression lineage, its subagents' parents and the session a pane resumes. The frontend opens no Hermes file: sessions, transcripts and subagents come from the gateway. The output of the session's background processes, and the log files that their commands write to (for charts). The files you open from the chat. |
| **Stored data** | `$HERMES_HOME/plugin-data/hermes-tern/`: linked pull requests, the conversation each Tern pane last showed (to resume it after a crash) and chart rules. Which pane shows which session (with its Tern variables) is kept in the gateway's memory only. `$HERMES_HOME/hermes-tern/settings.json`: the theme and chart settings. While a chat runs, a temporary file holds the id of the session the pane shows; `hermes tern` reads it when the chat ends and deletes it. |

## How it works

```mermaid
flowchart LR
  subgraph Tern pane
    T[Tern] <-->|TSP| F[frontend/dist/entry.js<br/>the chat UI]
  end
  F <-->|JSON-RPC| G[Hermes gateway<br/>shared by the profile]
  subgraph Hermes
    G --> A[agent + tools]
    P[hermes-tern plugin<br/>tern_env.py · viewers.py ·<br/>charts.py · pull_requests.py ·<br/>render_hints.py · figure_check.py] -.session env, RPC, tools.-> G
  end
  A -->|shell commands, with<br/>the pane's TERN_PANE| T
```

- **`launcher.py`** is `hermes tern`. It parses its own flags, picks the session (`-r`, `-c`, or the pane's own), and runs `node frontend/dist/entry.js` with `HERMES_TERN_*` variables: the session, the first prompt, the launch flags as `session.create` fields, the shell's variables for the session (Hermes' own `shell_client_env()`), and the command that runs this Hermes (Hermes' own `hermes_command()`, so the same install and profile). On exit code 75 (no TSP) it says that the terminal is not a Tern pane, and exits. In a Tern pane whose last chat died, **`panes.py`** picks that pane's conversation: the frontend records each pane's conversation in `$HERMES_HOME/plugin-data/hermes-tern/panes/<TERN_PANE>.json`, because Tern's daemon restarts only omp after a crash. Around the frontend it calls Hermes' published launcher functions: `-w`/`--worktree` makes the session's worktree before the chat and settles it after (`hermes_cli.session_worktree`), and a quit prints Hermes' "Resume this session with" lines (`print_exit_summary`). The frontend writes the session it shows to the file named in `HERMES_TERN_SESSION_FILE`, so the launcher knows which session the pane ended on. A Hermes without these functions gets one line: run `hermes update`.
- **`frontend/`** is the TSP frontend: a TypeScript app on [`@stencil-hq/tern`](https://www.npmjs.com/package/@stencil-hq/tern). It attaches to the profile's shared Hermes gateway with `hermes gateway attach --json` and talks to it (`hermes-gateway-v1`) through Hermes' shared Node client, `@hermes/shared/gateway-client`. `frontend/dist/entry.js` is committed, so an install needs no build step. CI builds it on `main` after each merge (`.github/workflows/bundle.yml`); pull requests carry source only. [`frontend/README.md`](frontend/README.md) maps its modules.
- **What the frontend reads.** Everything about sessions comes from the gateway: the session picker from `session.list` (a page of 200 at a time, the current folder and the search text filtered by the gateway), its preview and the compaction markers from `session.transcript`, subagent rows from the `subagent.*` events, and a subagent's transcript from `session.transcript` with `subagent_id`. The connect card is the gateway's own (`connection.request`). The frontend opens none of Hermes' files. At each connect it reads `runtime.describe` and needs the capabilities `plugin-rpc-v1`, `session-client-v1`, `session-list-picker-v1`, `session-list-cursor-v1` and `session-transcript-v1`.
- **`tern_env.py`** is needed because the agent's tools run in that shared gateway, not in the chat's pane. It registers the pane's `TERN_PANE` and window variables with Hermes' `ctx.register_session_env`: Hermes asks for them each time it starts a shell command for a session (in the foreground, in the background, and from a Python cell), and a subagent gets its parent conversation's pane. **`viewers.py`** knows which pane shows which session: each pane tells it over plugin RPC (`viewer.set` when it shows a session, also after a reconnect, and `viewer.clear` when it stops). The command is not changed, so the model, the approval sheet and the shell see the same text. So plain `tern open`, `tern split` and the rest of Tern's CLI act beside the chat. [`docs/tern-blocks.md`](docs/tern-blocks.md) is a short guide to scripting blocks that way: split, run, capture, wait and close.
- **`pull_requests.py`** holds the link tools and serves `plugin.hermes-tern.pull_requests.linked`, which the pane reads its list from. When a link tool changes the list (also from a subagent), it sends the pane the event `pull_requests.changed`. **`sessions.py`** is the one module that reads Hermes' session database, through `hermes_state`.
- **`render_hints.py`** registers the prompt section that says what Tern draws. Only a session the frontend created gets it: the frontend names itself on `session.create`, and Hermes gives that name to prompt sections. **`figure_check.py`** serves `plugin.hermes-tern.figures.check`. The first pane to ask about a reply gets the check; the result comes back to the session as the plugin event `figures.checked`.
- **`charts.py`** serves the plugin RPC method `plugin.hermes-tern.charts.author`. The frontend calls it on its gateway connection when it wants a background process's chart rules. The Python half redacts the samples, asks the auxiliary model (task `tern_charts`, through `ctx.llm`) for one JSON answer, and sends the answer back to the session as a plugin event. The frontend validates the rules and runs them (`frontend/src/processes/widgets/`, ported from omp's job widgets). It uses Node's linear-time regex engine, so no rule can stall the chat.

> [!NOTE]
> **Compatibility.** The bundle inlines `@hermes/shared` (`apps/shared`) from the Hermes commit in `frontend/hermes-src.lock`: the gateway client, its types and skins. At run time it attaches with `hermes gateway attach --json` and speaks the gateway's public `hermes-gateway-v1` contract. `requires_hermes` cannot say which `main` build the plugin needs, because every build since the release reports 0.23.0. The capability check at connect does.

## Development

```sh
hermes plugins validate .                         # the catalog's admission checks
uv run --with pytest pytest -q                    # the Python side (no Hermes checkout needed)

cd frontend
HERMES_SRC=~/path/to/hermes-agent bun run setup   # links .hermes-src, installs (bun)
bun run check                                     # typecheck, tests, lint, size and strictness ratchets
bun run bundle                                    # rebuilds dist/entry.js for local runs: do not commit it
```

<details>
<summary><b>The lab: drive the UI without credentials</b></summary>

`lab/fake_model.py --home DIR` writes a disposable `HERMES_HOME` that points at a loopback model, and then serves that model. The prompt picks the flow: "approve", "clarify", "tool", "work…", "delegate…", "errands…", "jobchart…", "pr URL…" and more. The file's docstring lists them all. Any other prompt streams Markdown.

Pair the fake model with a headless Tern (`tern serve --control PORT`, then `tern ctl --control PORT run|type|key|shot …`) to check the UI. The screenshots in this README come from that setup.

`lab/chartbench.ts` replays real background jobs (their recorded output and log files) through the chart registry and the auxiliary model, and reports which jobs chart.

</details>

## Credits

The frontend began as [can1357](https://github.com/can1357)'s `ui-tsp` (`can1357/hermes-agent@tern-frontend`). It keeps omp's chat roles (`omp.session`, …), which Tern's chat styles, tool folding and Carly integration are written against. Some UI patterns come from [T3 Code](https://github.com/pingdotgg/t3code).

## License

MIT. See [`LICENSE`](LICENSE).
