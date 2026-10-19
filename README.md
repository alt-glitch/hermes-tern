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

```sh
hermes plugins install alt-glitch/hermes-tern
hermes tern                 # in a Tern pane
hermes tern -c              # every `hermes chat` flag works: -m, -q, --image, --resume, --worktree, …
```

`hermes tern` describes the chat to Tern over its Surface Protocol (TSP), so Tern draws it with its
own components: Markdown, folds, diffs, sheets, asides and keys. Outside Tern (or inside
tmux/screen/zellij) there is no TSP answer, and `hermes tern` starts the regular TUI instead. To
open Hermes in Tern's agent pane, set Tern's agent command (`agent_command` in Tern's settings) to
`hermes tern`.

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
of. PRs are read from GitHub with your own token (`GH_TOKEN`, else `gh auth token`).

## How it works

- `__init__.py` registers `hermes tern`. It runs `hermes chat --tui <flags>` with
  `HERMES_TUI_DIR` pointing at `frontend/`, so Hermes' own launcher still does profile, cwd,
  resume, worktree, the gateway attach and the exit summary. Exit code 75 (no TSP) reruns
  `hermes chat --tui` without it.
- `frontend/` is the TSP frontend, a TypeScript app on [`@stencil-hq/tern`](https://www.npmjs.com/package/@stencil-hq/tern).
  It talks to the profile's shared Hermes gateway (`hermes-gateway-v1`) through Hermes' own
  gateway client. `frontend/dist/entry.js` is committed, so installing needs no npm step.
- The agent's tools run in that shared gateway, not in the chat's pane, so `tern_env.py` gives every
  process the agent starts (commands, background processes, a Python cell's commands) the
  `TERN_PANE` and window variables of the pane that shows its conversation, read from the pane's
  marker when the process starts. Plain `tern open`, `tern split` and the rest of Tern's CLI act
  beside the chat, as they do from `hermes chat` in a Tern pane.
- The frontend began as [can1357](https://github.com/can1357)'s `ui-tsp`
  (`can1357/hermes-agent@tern-frontend`) and keeps omp's chat roles (`omp.session`, …), which
  Tern's chat styles, tool folding and Carly integration are written against.

### Compatibility

The bundle inlines Hermes' renderer-free ui-tui modules (gateway client, skins) and
`apps/shared` from the Hermes commit it was built against; the build prints it. At runtime it
runs that client against the installed Hermes, which starts the gateway through
`ui-tui/scripts/gateway_bootstrap.py`. That script and the gateway wire are Hermes internals:
rebuild against a newer Hermes when they change.

## Developing

```sh
cd frontend
HERMES_SRC=~/path/to/hermes-agent npm run setup   # links .hermes-src, installs
npm run check                                     # typecheck + tests
npm run bundle                                    # rebuilds dist/entry.js
```

`lab/fake_model.py --home DIR` writes a disposable `HERMES_HOME` pointed at a loopback model and
serves it. The prompt picks the flow: "approve", "clarify", "tool", "work…", "delegate…",
"errands…", "pr URL…" and more (the file's docstring lists them all); anything else streams
Markdown. Pair it with a headless Tern (`tern serve --control PORT`, then
`tern ctl --control PORT run|type|key|shot …`) to check the UI without credentials. The
screenshots above come from that setup.

## License

MIT. See `LICENSE`.
