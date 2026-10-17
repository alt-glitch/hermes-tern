# hermes tern: spec and scope

## Goal

`hermes tern` is Sid's daily Hermes: a native Tern agent UI that runs on upstream Hermes `main`
as this plugin alone. It covers what he relied on in his OpenTUI fork, adds what only Tern can
do (native subagent views, Tern's own themes, files and git in the terminal), and it ships as
small merged pull requests, each one tried in a lab tab first.

Done means: Sid stops wanting another frontend. Each milestone below lists the checks that
prove it.

## Rules

- **Plugin only.** Nothing changes in Hermes core. Data the shared gateway does not serve comes
  from what a local process may read (the profile's `state.db` read-only, the delegation live
  logs), never from patches. No `HERMES_*` variables for settings: the plugin keeps its own in
  `<home>/hermes-tern/settings.json`.
- **Tern draws.** Prefer Tern's elements and roles (omp's vocabulary) over hand-drawn layout, so
  Tern's chat styles, themes and motion apply.
- **Ship small.** One feature per branch in `~/github/hermes-tern-subagents`; PR to `main`,
  merge, fast-forward `~/github/hermes-tern` (the plugin Hermes loads), play a sound.
- **Prove it in the lab.** `lab/fake_model.py` plus a headless `tern serve` for screenshots;
  a tab in Sid's window for the demo. Tests for the logic (`npm run check`).

## Shipped

| PR | What |
| --- | --- |
| #1 | /steer, /queue, /stop, /tools through the shared gateway's own RPCs |
| #2 | Live subagents: Task card rows, the agents pill, the agents hub with timelines, steer and stop; copy buttons as icons, one under each answer |
| #3 | Tern's theme by default; `/theme` (Tern, Nous, Hermes skin); correct agent timers |
| #4 | Skill and path completion on every line of a draft |
| #5 | This spec |
| #6 | Subagent sidebar: the full transcript beside the chat, steerable |
| #7 | Summarised tool runs |
| #8 | Cache hit and tokens per second |
| #9 | A click on an agent row opens it beside the chat |
| #10 | `chat --tui` runs in the plugin's own process (faster start) |
| #11 | A click on the context meter no longer runs /usage |
| #12 | Slash output as Markdown; a structured /usage view |
| #13 | Steer the running turn from a queued prompt (Steer button, Alt+Enter) |
| #14 | Tool cards say what a step is for; runs list one line per step |
| #15 | /usage rate limits say how much is left |
| #16 | Opening a card no longer scrolls; turns Hermes starts by itself are marked |
| #17 | A steer shows inside the turn it joined, where it landed |
| #18 | Background processes: pill, sheet and live terminal cards |
| #19 | Hermes' own notices become a reason line, not a user bubble |
| #20 | The work log as t3code draws it: "Working for", work groups, thought rows, "Worked for" folds |
| #21 | A steer stays in view; each stretch around it folds on its own |
| #22 | Live process output; the Background sheet's Cron tab (every cron job and monitor: pause, resume, remove) |
| next | `link_pull_request` and the Pull requests sheet: PRs, checks, activity, files, merge and close |

## Milestones

### M1. Subagent transcripts, side by side

Sid wants to watch a subagent the way he watches the main chat, and to talk to it.

- **Sidebar pane.** From the hub (and a key on a Task card row), open the agent in a real Tern
  split beside the chat: a second `hermes tern` process in agent mode (`tern split $TERN_PANE
  right -- hermes tern --agent <session> <subagent>`). It draws the child's transcript with the
  same transcript views as the main chat, live.
- **Data.** Running: the child's live log (steps as they happen). Full transcript: the child's
  session in `state.db` (`sessions.parent_session_id`, `source='subagent'`), read-only through
  `node:sqlite`, rendered with `Transcript.load`. The shared gateway serves neither.
- **Steer from the sidebar.** The sidebar's composer sends `subagent.steer`; Esc-Esc or a Stop
  button sends `subagent.interrupt`. Finished agents get a read-only composer.
- **Tool summaries.** Runs of tool calls fold into one line that says what happened ("Read 4
  files, ran 2 commands, edited app.ts"), in the sidebar and the main chat; a click unfolds.
- Check: in the lab, a delegation opens a sidebar per agent that streams steps, shows the full
  transcript after the agent ends, and delivers steering text (gateway log shows it).

### M2. Numbers that matter

- Under each answer (hover line): time, tokens, cache hit, tokens per second.
- In the composer bar: context meter (exists), cache hit and tokens per second
  (`omp.composer.rate`), dropping whole facts when narrow.
- Source: `session.usage` events (cumulative cache_read, prompt tokens, `tokens_per_s`,
  `avg_latency_s`) and `message.complete.usage` (`cache_hit_pct`, `avg_tps`).
- Check: lab turns show the facts; values match `session.stats`.

### M3. Sessions: new, branch, resume

- `/new [title]`: `session.create`. `/branch`, `/fork [title]`: `session.mutate` operation
  `branch` (the view follows the child).
- `/resume`: one sheet with live sessions first, then stored ones from this folder, then the
  rest; search, a preview of the conversation, delete with confirm, a "new session" row that
  takes a first prompt. `/resume <id|title>` resolves directly.
- `/title`.
- Check: each command works in the lab against the shared gateway.

### M4. Models and effort

- `/model` shows Recent and Most used groups before providers. Recency comes from the plugin's
  own record of switches plus `state.db` (`session_model_usage`) for history; subagent runs do
  not count.
- Effort is reachable at any width: a click on the effort chip (or Tern's effort glyph in the
  model chip) opens a level picker; the model picker carries an effort strip.
  Set with `config.set` key `reasoning` (session scope; Ctrl+G for global).
- Check: recents order follows use; effort changes show in `session.info`.

### M5. Settings commands

Commands the shared gateway refuses through `slash.exec` get their dedicated RPCs:
`/skin` (`config.set skin`, and theme mode `skin`), `/reasoning`, `/fast`, `/yolo`, `/verbose`,
`/personality`, `/busy`, `/approvals`; `/config` opens a read-only sheet of `config.get full`.
Check: none of these says "not available on the shared gateway".

### M6. Files, git and worktrees

- A branch and worktree picker from the composer's folder and branch facts (Zed and t3code as
  the reference): switch branch, switch worktree, create a worktree from a branch. Git runs in
  the frontend; the session moves with `session.mutate` operation `workspace`; OSC 7 tells
  Tern the new folder.
- Paths in answers and tool cards open in Tern's file block (`href`); edits show as `diff`.
- Check: switching a worktree in the lab changes the session's cwd and branch facts.

### M7. Design pass

- Tern theme by default (done in #3); the Nous palette keeps gold for earned moments.
- `#123` in prose no longer turns into a color swatch (Tern reads it as a hex color): escape it
  in Markdown.
- Quieter chrome: fewer mono labels, no gold text, notices in plain words, a calmer welcome.
- Tern pane status: working, waiting for an answer, done (OSC 7501 or OSC 9 notifications),
  so the tab icon and inbox reflect Hermes.
- Check: screenshots in light and dark Tern themes before and after.

### M8. A lab that tests itself

Script the lab (`tern serve`, `tern ctl`, the fake model) into an end-to-end check that runs
the flows above and asserts on `tern ctl tree`.

## Order

M1 and M2 first (what Sid asked for most), then M3, M4, M5, M7, M6, M8. Small fixes found on
the way ship as their own PRs.

## Sources

Recon notes in `~/side-quests/tern-hermes/.scratch/recon/`: `subagent-viewer.md`,
`opentui-features.md`, `hermes-shared-gateway-rpcs.md`, plus the Tern docs mirror in
`.scratch/docs/tern/`.
