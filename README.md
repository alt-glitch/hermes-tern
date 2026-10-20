<h1 align="center">hermes-tern</h1>

<p align="center">
  <b><a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a>, drawn natively by <a href="https://stencil.so/tern">Tern</a>.</b><br>
  The transcript, tool cards, approvals, subagents and pull requests are real Tern UI, not text in a terminal.
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

Needs Hermes Agent 0.22.2 or later and [Tern](https://stencil.so/tern) (built and tested on 0.9.5).
Then, in a Tern pane:

```sh
hermes tern                 # the chat, drawn by Tern
hermes tern -c              # every `hermes chat` flag works: -m, -q, --image, --resume, --worktree, …
```

`hermes tern` describes the chat to Tern over its Surface Protocol (TSP), so Tern draws it with its
own components: Markdown, folds, diffs, sheets, asides and keys. Outside Tern (or inside
tmux/screen/zellij) there is no TSP answer, and `hermes tern` starts the regular TUI instead. To
open Hermes in Tern's agent pane, set Tern's agent command (`agent_command` in Tern's settings) to
`hermes tern`.

## What it adds

| | |
| --- | --- |
| `hermes tern` | `hermes chat --tui` with this plugin's Tern frontend; the Ink TUI outside Tern |
| `link_pull_request`, `unlink_pull_request`, `list_pull_requests` | tools: the PRs a conversation works on, shown above the composer |
| `transform_tool_result` hook | a connector's connect result becomes a card in the chat that started it |
| `tool_request` middleware | the agent's shell commands run with the chat's `TERN_PANE`, so `tern open` works beside the chat |
| `tern_charts` auxiliary task | writes the rules behind a background process's live chart (`auxiliary.tern_charts` picks its model) |
| system prompt section | tells the agent to link the PRs it opens |

## The chat

A turn shows what the agent does while it does it: its reasoning, short notes, and tool calls
grouped into one line per run ("Ran 3 commands"). A todo list stays live in the transcript and in
the status line. When the turn ends, the work folds into "Worked for 9.5s" and the answer stays.

<table>
  <tr>
    <td width="50%"><img alt="A turn in progress with a live todo list" src="docs/images/transcript.png"></td>
    <td width="50%"><img alt="An approval sheet for a flagged command" src="docs/images/approval.png"></td>
  </tr>
  <tr>
    <td><b>Live work.</b> Tool runs fold to one line; the todo list ticks as it goes.</td>
    <td><b>Approvals.</b> A flagged command asks first: once, for the session, always, or deny.</td>
  </tr>
  <tr>
    <td><img alt="Three delegated subagents running in the background" src="docs/images/subagents.png"></td>
    <td><img alt="The session sidebar docked at the pane's edge" src="docs/images/sidebar.png"></td>
  </tr>
  <tr>
    <td><b>Subagents.</b> A delegated batch is one card, one row per agent, with its model and tool count.</td>
    <td><b>Sidebar</b> (⌥S). The branch, the session's pull requests and the changed files.</td>
  </tr>
</table>

Also: `/model` and `/effort` from the composer chips, `/sessions` to resume, `/ps` for background
processes and cron jobs, `/agents` for subagents, `/changes` for the working tree's diff, and
`/theme` to paint the chat in Tern's colors, Nous colors or the Hermes skin.

## Background processes

A command the agent runs in the background (`terminal(background=true)`) gets a live chart, as in
omp. After 15 s of output, Hermes' auxiliary model reads the command and samples of its output
once and writes rules that pull numbers out of each line (throughput, latency, loss, tests passed,
progress toward a total the command states), or declines when nothing is worth charting. From then
on the plugin applies the rules to every new line itself, with no further model calls. A command
that sends its output to a log file (`> /tmp/run.log 2>&1`, `| tee run.log`) is charted from that
file. A decline is asked again once the output has doubled, since a job often starts with setup
lines and prints its numbers later.

<p align="center"><img alt="The shells pill with a job's figure and mini chart, its hover card above a column chart with a dashed goal line" src="docs/images/job-chart.png" width="600"></p>

The shells pill shows the freshest figure and a mini chart; hover it for a tile per running
process. The background terminal card draws the primary chart under its live line, a
`process_manage` wait or poll on the process draws its tile (in view while the agent waits, as
omp's `wait` card), and the Background sheet (`/ps`, ⌥J) the whole chart above the output. Each
process's rules are kept in `$HERMES_HOME/plugin-data/hermes-tern/charts/`, so another pane on the
session, or a resumed one, charts it without asking the model again. Goals the command states draw as
dashed lines. The request goes to the plugin's `tern_charts` auxiliary task, so `auxiliary.tern_charts`
in `config.yaml` (or Hermes' model picker) chooses a cheap model for it, and Hermes redacts secrets in the samples before they
leave. Turn charts off with `"jobCharts": false` in `$HERMES_HOME/hermes-tern/settings.json`.

## Pull requests

The agent links every PR it opens or works on, as T3 Code does. The pill above the composer counts
them; click it (or ⌥P) and a tray drops up with each PR's state and age.

<p align="center"><img alt="The PR tray above the composer" src="docs/images/pr-tray.png" width="760"></p>

Pick one and it docks at the chat's right edge, beside the conversation. The chat narrows and
keeps the keys, so you can go on talking to the agent while the PR stays in view. `/prs 22` opens
#22 directly.

<table>
  <tr>
    <td width="42%"><img alt="The Files tab: Tern's own edit cards and diffs" src="docs/images/pr-files.png"></td>
    <td>

**Drawn as GitHub draws it.** PR bodies and comments go through the same pipeline T3 Code's PR
panel uses (`remark-gfm`, `rehype-raw`, GitHub's sanitize schema). `<details>` become folds, bot
badges become links, HTML comments go away, and tables, task lists, alerts and mermaid draw
natively. `#123` and `@login` link.

**Three tabs, as on GitHub.**

- **Conversation**: the description, then every comment, review, review thread and commit, in order.
- **Checks**: failing and running checks open; passed and skipped ones folded.
- **Files**: each file is Tern's own edit card with its diff, highlighted and folded around the hunks.

**Actions.** Merge and close (both ask first), ready for review, update branch, re-run failed
jobs, copy `gh pr checkout N`, open on GitHub.

The aside is as wide as Tern's Settings sheet: drag that sheet's edge (⌘,) to resize it.

</td>
  </tr>
</table>

The agent gets three tools: `link_pull_request`, `unlink_pull_request` and `list_pull_requests`.
Links are kept per conversation in `$HERMES_HOME/plugin-data/hermes-tern/pull-requests.json`, so
they survive compression and resume. The list also shows two kinds of PR the agent did not link:
the PR of the session's branch, and the other layers of a GitHub stack that a listed PR is part
of. PRs are read from GitHub with your own token, which Hermes provides: set it once with
`hermes config set GITHUB_TOKEN <token>` (for example the output of `gh auth token`). The plugin
never reads another tool's login.

## Security and privacy

What the plugin does beyond drawing the chat, so you can decide before installing:

- **Network.** GitHub's API, with the token Hermes gives it (`GITHUB_TOKEN`), for the pull request
  view and actions you click (merge and close ask first). The job charts send the command and
  samples of a background process's output, redacted by Hermes first, to your own auxiliary model
  (`auxiliary.tern_charts`), once per process. Nothing else; no telemetry.
- **Commands.** A `tool_request` middleware adds `export TERN_PANE=…` (the chat's Tern pane) before
  the agent's shell commands in sessions a Tern pane shows; approvals and guards see the command
  as it runs. `!cmd` and `{!cmd}` in the composer run through Hermes' own `shell.exec` (its
  dangerous-command refusal applies), and only when typed: a pasted `{!cmd}` never runs. The
  composer's `/` commands are Hermes' own.
- **Processes.** `hermes tern` runs `hermes chat --tui` in the same process. The chart helper
  (`widget_author.py`) runs in Hermes' interpreter for one model request and exits. Opening the
  sidebar or a file beside the chat runs Tern's own `tern` CLI.
- **Reads outside its data.** Hermes' session database (read-only: a conversation's compression
  lineage and its subagents' parents); the output of the session's background processes, and the
  log files their commands write to (for charts); the files you open from the chat.
- **Stored data.** `$HERMES_HOME/plugin-data/hermes-tern/`: linked pull requests, which panes show
  which sessions (with their Tern variables), chart rules, connect cards.
  `$HERMES_HOME/hermes-tern/settings.json`: theme and chart settings.

## How it works

- `__init__.py` registers `hermes tern`. It runs `hermes chat --tui <flags>` with
  `HERMES_TUI_DIR` pointing at `frontend/`, so Hermes' own launcher still does profile, cwd,
  resume, worktree, the gateway attach and the exit summary. Exit code 75 (no TSP) reruns
  `hermes chat --tui` without it.
- `widget_author.py` runs in Hermes' interpreter when the frontend asks for a background
  process's chart rules: it calls the auxiliary model (task `tern_charts`) and prints the answer.
  The frontend validates the rules and runs them (`frontend/src/processes/widgets/`, ported from
  omp's job widgets), using Node's linear-time regex engine so no rule can stall the chat.
- `frontend/` is the TSP frontend, a TypeScript app on [`@stencil-hq/tern`](https://www.npmjs.com/package/@stencil-hq/tern).
  It talks to the profile's shared Hermes gateway (`hermes-gateway-v1`) through Hermes' own
  gateway client. `frontend/dist/entry.js` is committed, so installing needs no npm step.
- The agent's tools run in that shared gateway, not in the chat's pane, so `tern_env.py` (a
  `tool_request` middleware) puts an `export` of the `TERN_PANE` and window variables of the pane
  that shows the conversation before each shell command the agent runs (in the foreground, in the
  background, and from a Python cell), read from the pane's marker at the call. The model's history
  keeps the command as it wrote it, and the frontend leaves the prefix out of what it shows. Plain `tern open`, `tern split` and the rest of Tern's CLI act
  beside the chat, as they do from `hermes chat` in a Tern pane. [`docs/tern-blocks.md`](docs/tern-blocks.md) is
  the short guide to scripting blocks that way: split, run, capture, wait, close.
- The frontend began as [can1357](https://github.com/can1357)'s `ui-tsp`
  (`can1357/hermes-agent@tern-frontend`) and keeps omp's chat roles (`omp.session`, …), which
  Tern's chat styles, tool folding and Carly integration are written against.

### Compatibility

The bundle inlines Hermes' renderer-free ui-tui modules (gateway client, skins) and
`apps/shared` from the Hermes commit it was built against; the build prints it. At runtime it
runs that client against the installed Hermes, which starts the gateway through
`ui-tui/scripts/gateway_bootstrap.py`. That script and the gateway wire are Hermes internals:
rebuild against a newer Hermes when they change.

## Development

```sh
hermes plugins validate .                         # the catalog's admission checks
uv run --with pytest pytest -q                    # the Python side (no Hermes checkout needed)

cd frontend
HERMES_SRC=~/path/to/hermes-agent bun run setup   # links .hermes-src, installs (bun)
bun run check                                     # typecheck + tests
bun run bundle                                    # rebuilds dist/entry.js: commit it with the change
```

`lab/fake_model.py --home DIR` writes a disposable `HERMES_HOME` pointed at a loopback model and
serves it. The prompt picks the flow: "approve", "clarify", "tool", "work…", "delegate…",
"errands…", "jobchart…", "pr URL…" and more (the file's docstring lists them all); anything else streams
Markdown. `lab/chartbench.ts` replays real background jobs (their recorded output and log files) through the
chart registry and the auxiliary model, and reports which ones chart. Pair the fake model with a headless Tern (`tern serve --control PORT`, then
`tern ctl --control PORT run|type|key|shot …`) to check the UI without credentials. The
screenshots above come from that setup.

## License

MIT. See `LICENSE`.
