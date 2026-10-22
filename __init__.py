"""Hermes for Tern.

``hermes tern [flags]`` runs ``hermes chat --tui [flags]`` with ``HERMES_TUI_DIR`` pointing at this
plugin's prebuilt frontend (``frontend/dist/entry.js``), so Hermes' own TUI launcher keeps doing
everything else: profile, cwd, resume, worktree, the gateway attach and the exit summary. The
frontend exits ``NO_TSP_EXIT`` when the terminal does not answer the Tern Surface Protocol
handshake; the Ink TUI then runs in its place.

In a Tern pane whose last ``hermes tern`` died (a crash, a kill, Tern's daemon restarting), a launch
with no session flag resumes the conversation that pane showed (``panes.py``); ``--new`` starts fresh.
"""

import argparse
import os
import sys
from pathlib import Path

from . import connections, panes, pull_requests, tern_env

FRONTEND = Path(__file__).resolve().parent / "frontend"

# frontend/src/entry.ts NO_TSP: the terminal never answered the TSP handshake.
NO_TSP_EXIT = 75


def _setup(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "tui_args", nargs=argparse.REMAINDER, metavar="FLAGS",
        help="`hermes chat` flags, e.g. --resume ID, -c, -m MODEL, -q QUERY, --image PATH, --worktree; "
             "--new starts a fresh session where the pane would resume its last one")
    parse = parser.parse_known_args

    def passthrough(args=None, namespace=None):
        # Every flag belongs to `hermes chat`, which validates them; argparse would refuse a leading
        # `--image` here because REMAINDER only starts at a positional.
        args = list(sys.argv[1:] if args is None else args)
        if "-h" in args or "--help" in args:
            return parse(args, namespace)
        known, _ = parse([], namespace)
        known.tui_args = args
        return known, []

    parser.parse_known_args = passthrough


def _chat(flags: list[str], tui_dir: str | None, env: dict[str, str] | None = None) -> int:
    """``hermes chat --tui FLAGS`` in this process, with ``env`` set while it runs: a second
    interpreter would boot Hermes again (bootstrap, the PM check, imports), which is most of what
    ``hermes tern`` spends starting."""
    from hermes_cli.main import main

    env = {**(env or {}), "HERMES_TUI_DIR": tui_dir}
    argv, saved = sys.argv, {k: os.environ.get(k) for k in env}
    sys.argv = [argv[0], "chat", "--tui", *flags]
    for k, v in env.items():
        if v:
            os.environ[k] = v
        else:
            os.environ.pop(k, None)
    try:
        code = main()
    except SystemExit as done:
        code = done.code
    finally:
        sys.argv = argv
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    return code if isinstance(code, int) else (0 if code is None else 1)


def _run(args: argparse.Namespace) -> None:
    bundle = FRONTEND / "dist" / "entry.js"
    if not bundle.is_file():
        print(f"hermes tern: {bundle} is missing; reinstall the plugin", file=sys.stderr)
        sys.exit(1)
    flags = [a for a in args.tui_args if a != "--"]
    # `hermes -w tern`: the top-level flag lands on `args`, not in tui_args; Hermes' TUI launcher is what
    # makes the worktree and points the session, HERMES_CWD and TERMINAL_CWD at it.
    if getattr(args, "worktree", False) and not {"-w", "--worktree"} & set(flags):
        flags = ["--worktree", *flags]
    # Read before a resume moves to the session's folder: the pane file records where the pane launched.
    env = {panes.LAUNCH_CWD_ENV: os.getcwd()}
    flags, restored = panes.plan(flags)
    if restored:
        env[panes.RESTORED_ENV] = restored
    code = _chat(flags, str(FRONTEND), env)
    if code == NO_TSP_EXIT:
        print("hermes tern: this terminal does not speak the Tern Surface Protocol; "
              "starting the regular TUI", file=sys.stderr)
        code = _chat(flags, None)
    sys.exit(code)


def register(ctx) -> None:
    ctx.register_cli_command(
        name="tern", help="Chat in Tern's native UI (falls back to the regular TUI elsewhere)",
        setup_fn=_setup, handler_fn=_run,
        description="Runs `hermes chat --tui` with the Tern frontend; every `hermes chat` flag works.")
    # The chart rules of background processes (frontend/src/processes/widgets, widget_author.py):
    # its own `auxiliary.tern_charts` config block and model picker entry.
    ctx.register_auxiliary_task(
        "tern_charts", display_name="Tern job charts",
        description="Writes the rules behind a background process's live chart in `hermes tern`, once per process.")
    pull_requests.register(ctx)
    connections.register(ctx)
    tern_env.register(ctx)
