# kvnloo/hermes-tern

A fork of [alt-glitch/hermes-tern](https://github.com/alt-glitch/hermes-tern), the community plugin
that draws [Hermes Agent](https://github.com/NousResearch/hermes-agent) natively in
[Tern](https://stencil.so/tern). The fork carries features ported from the Hermes TSP frontend and
from OMP, plus fixes that make tool cards say what actually happened. Upstream's
[README](README.md) still describes the base plugin; this file describes only what differs.

- [What the fork adds](#what-the-fork-adds)
- [Behavior that differs from upstream](#behavior-that-differs-from-upstream)
- [Install the fork](#install-the-fork)
- [Branches and pull requests](#branches-and-pull-requests)
- [Staying in sync with upstream](#staying-in-sync-with-upstream)
- [Development and CI](#development-and-ci)
- [Security additions](#security-additions)

## What the fork adds

Each row links to the feature's own document. Merged PR numbers are in this fork.

| Area | Feature | Docs | PR |
| --- | --- | --- | --- |
| Transcript | LSP diagnostics as native result cards | | #2 |
| | Charts drawn from settled Markdown tables | [table-charts](frontend/docs/table-charts.md) | #3 |
| | OpenUI visual previews | [openui](frontend/docs/openui.md) | #4 |
| | Native ephemeral-ui intent boards (`ephemeral-intent/v1`) | [openui](frontend/docs/openui.md#intent-boards-ephemeral-intentv1) | parity wave 2026-11-04 |
| | Written artifacts, session links and pasted attachments | [artifacts-links](frontend/docs/artifacts-links.md) | #6 |
| | 3D tool artifacts beside the chat | | #28 |
| | Settled-turn retention and manual history paging | [retention](frontend/docs/retention.md) | #9 |
| | Bounded surface recovery after Tern drops the view | [retention](frontend/docs/retention.md) | #21 |
| Media and browser | Tern browser blocks, with a consent-gated gateway backend | [browser-blocks](frontend/docs/browser-blocks.md) | #5, #22 |
| | Image delivery across local and remote hosts | [MEDIA-DELIVERY](docs/MEDIA-DELIVERY.md) | #16, #24 |
| Composer | Optional Vim composer and external editor | [vim-editor](frontend/docs/vim-editor.md) | #8 |
| | Context meter opens a per-category context breakdown | | upstream #86 |
| | Shortcut preferences, command palette, model cycling | [SHORTCUTS](frontend/SHORTCUTS.md) | #10 |
| | Busy input: queue or steer while a turn runs | [below](#behavior-that-differs-from-upstream) | #14 |
| | Thinking orb on the composer | | #14, #194 |
| | Opt-in live voice and push-to-talk | [voice](frontend/docs/voice.md) | #15 |
| Planning | Plan review and the session todo HUD | [PLAN-REVIEW](frontend/PLAN-REVIEW.md) | #12, #25 |
| | Native `/btw` side questions and read-only MCP/SSH report sheets | [btw-operational-sheets](frontend/docs/btw-operational-sheets.md) | #13, #26 |
| Agents and panes | Live OMP-style wait tiles for subagents | | #18 |
| | Delegation IDs isolated across overlapping sessions | | #11 |
| | Fork a session into a sibling pane | | #7 |
| | `/rewind` to any earlier prompt (rewind or branch), `/undo N` | | upstream #68 |
| | `/tree`: a conversation's branches, open one | | upstream #69 |
| Accessibility | Every clickable control is a named native button, incl. agent rows and wait tiles | | upstream #70 |
| Settings | Native `/settings` and the `/models` provider hub | [below](#behavior-that-differs-from-upstream) | #20 |
| | Overlay ownership: stale sheets cannot act | | #23 |
| Launcher | Frontend channels: `hermes tern --channel NAME`, `hermes tern switch NAME` | | #193 |
| | Qualified Ink fallback on exit 75 | [below](#exit-75-fallback) | #19 |

Demo videos are in the PR that ships each feature. The tool-card fixes also have one film, the same
turn on upstream and on this fork for each fix: [hermes-tern-fixes-v2.mp4](https://github.com/kvnloo/hermes-tern/blob/0ddcb949dda3ed0cd8c5762cf0e4387673b6eacd/films/v2/hermes-tern-fixes-v2.mp4)
(78 s, 1080p60; files on the `pr-films` branch, which is never merged).

## Behavior that differs from upstream

**Busy input.** While a turn runs, Enter queues a follow-up and Alt+Enter steers the running turn.
Set `display.busy_input_mode` to `steer` to swap them; Tern's native Send follows Enter. An open
modal blocks Send without consuming the draft. A typed `{!cmd}` expands before a correction is
steered; a pasted one stays literal. A failed expansion or rejected steer keeps the draft.

**Subagents.** Active Task cards use the background-process tile frame, up to four agents per
frame with an overflow action that opens `/agents`. Each tile shows the agent's current tool and
its latest two assistant or tool-intent lines (160 characters each). Click a tile to open that
agent beside the chat, or its timeline sheet when Tern cannot split. When every agent finishes,
the card returns to result rows.

**Settings and Model Hub.** `/settings` (or `/prefs`) opens Tern's native preferences; `/models`
opens Hermes' provider inventory; `/model` is still the live session picker. Profile defaults and
session pins are separate scopes. Nothing is read at startup. Each read and write carries the
session's canonical profile name and ID, and fails closed without them. Writes are checked against
the value the sheet opened with and verified by reading back; changing a security policy asks
again. This is not atomic: two clients writing at once can race. Unsupported fields and provider
logins stay read-only and go through Hermes' own setup.

**Gateway reports.** On Hermes builds with session-attached plugin gateway methods,
`hermes-tern.operations.report` returns the profile's MCP configuration, cached status and catalog,
read-only. It never connects, authenticates, installs or returns secrets. Older Hermes shows
"Needs Hermes plugin gateway methods" in `/btw`; unsent side questions are kept.

### Exit-75 fallback

`hermes tern` is still one launcher: it runs `hermes chat --tui` with this frontend. Only exit
code 75 (no TSP answer) retries Hermes' Ink TUI with the same flags. `HERMES_TERN=0` uses Ink
directly. `tests/test_fallback_native.py` drives the real compiled entry through a real PTY and a
real Ink bundle; it is excluded from ordinary pytest runs (see `pytest.ini`) and needs a disposable
Hermes checkout at the commit in `frontend/hermes-src.lock`:

```sh
HERMES_FALLBACK_SOURCE=/tmp/hermes-src "$HERMES_PYTHON" -m pytest -q \
  -o 'addopts=--import-mode=importlib' -m native_fallback tests/test_fallback_native.py
```

## Install the fork

```sh
hermes plugins install kvnloo/hermes-tern
```

The checked-in `frontend/dist/entry.js` can lag the source on this fork (the bundle workflow needs a
deploy key the fork does not have). Build it yourself after installing or updating:

```sh
cd "${HERMES_HOME:-$HOME/.hermes}/plugins/hermes-tern/frontend"
bun install --frozen-lockfile && bun run bundle   # bun 1.4 or later
```

Or take a CI-built bundle: see [BUNDLE-ARTIFACT](docs/BUNDLE-ARTIFACT.md). To keep several
frontends side by side, register them as channels and switch a pane with `hermes tern switch NAME`.

## Branches and pull requests

| Branch | Role |
| --- | --- |
| `main` | Upstream main plus merged fork features. |
| `integration/nightly-*` | Reviewed fixes waiting to be promoted to `main` in one batch. Open PRs whose commits are already here are listed in the promotion PR. |
| `port/*`, `feat/*`, `fix/*` | One feature per branch, one draft PR each. |
| `codex/*`, `chatgpt/*` | Branches written by coding agents from issue bodies; reviewed and integrated by hand. |

Changes meant for upstream are rewritten on a branch from `alt-glitch/hermes-tern` main and
opened there separately; fork branches are never proposed upstream as they are.

## Staying in sync with upstream

The fork keeps its diff against upstream easy to merge:

1. **Add, don't edit.** New behavior goes into new files (`frontend/src/...`, `*_backend.py`,
   `frontend/docs/*.md`). When an upstream file has to change, keep the change small and local.
2. **Docs live here.** `README.md` stays upstream's text plus one note at the top; fork docs go in
   this file and `frontend/docs/`.
3. **Merge, don't rebase `main`.** Rebasing would rewrite every merged fork PR.

```sh
git remote add upstream https://github.com/alt-glitch/hermes-tern.git   # once
git fetch upstream
git switch main && git merge --no-ff upstream/main
# conflicts: keep both sides; for frontend/dist/entry.js take either and rebuild
(cd frontend && bun install --frozen-lockfile && bun run check && bun run bundle)
git push --no-follow-tags origin main
```

To see what the fork changes in an upstream file: `git diff upstream/main main -- <path>`. To list
only fork-added files: `git diff --diff-filter=A --name-only upstream/main main`.

## Development and CI

Development follows [README § Development](README.md#development). The fork adds:

- `checks` runs on `main` and `integration/nightly-*`. Required: `python` and `frontend`;
  `lint and ratchets` is separate. Python tests run in the pinned Hermes environment, because the
  port tests import Hermes core.
- The lint ratchet (`frontend/scripts/lint-legacy.json`) allows zero new `no-unsafe-*` and
  `consistent-type-assertions` findings. Narrow with annotations and `instanceof`, never `as`.
- `lab/fake_model.py` is a loopback model for driving `hermes tern` without credentials; its
  docstring lists the scripted flows.
- `.github/workflows/fettl.yml` offers a local changed-code gate (#27).

## Security additions

These extend the table in [README § Security and privacy](README.md#security-and-privacy).

| | |
| --- | --- |
| **Settings RPCs** | Opening `/settings` or `/models` asks the gateway for individual normalized preferences and public provider names. Writes use Hermes' `config.set` and a read-back; security-policy changes ask for confirmation. No full profile config or provider secrets are read. |
| **Browser** | Browser blocks act only on explicit user intents bound to the calling session. Driving a browser needs explicit operator consent through the per-profile `tools.override` capability; the plugin never grants it. |
| **Media** | Images are staged by content for the session that asked for them; a staged file that changes underneath is refused. See [MEDIA-DELIVERY](docs/MEDIA-DELIVERY.md). |
| **Gateway reports** | MCP and SSH reports are read-only and never connect, authenticate or return secrets. |

## Credits

The plugin is by its upstream maintainers. Hermes Agent is by Nous Research. The Tern Surface
Protocol and SDK are by Can Bölük and Stencil Labs. Feature designs follow the Hermes TSP frontend
and OMP.
