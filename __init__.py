"""Hermes for Tern.

``hermes tern [flags]`` runs ``hermes chat --tui [flags]`` with ``HERMES_TUI_DIR`` pointing at this
plugin's prebuilt frontend (``frontend/dist/entry.js``), so Hermes' own TUI launcher keeps doing
everything else: profile, cwd, resume, worktree, the gateway attach and the exit summary. The
frontend exits ``NO_TSP_EXIT`` when the terminal does not answer the Tern Surface Protocol
handshake; the Ink TUI then runs in its place.
"""

import argparse
import os
import sys
from pathlib import Path

from . import connections, pull_requests, render_hints, tern_env

FRONTEND = Path(__file__).resolve().parent / "frontend"

# frontend/src/entry.ts NO_TSP: the terminal never answered the TSP handshake.
NO_TSP_EXIT = 75


def _setup(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "tui_args", nargs=argparse.REMAINDER, metavar="FLAGS",
        help="`hermes chat` flags, e.g. --resume ID, -c, -m MODEL, -q QUERY, --image PATH, --worktree")
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


def _chat(flags: list[str], tui_dir: str | None) -> int:
    """``hermes chat --tui FLAGS`` in this process: a second interpreter would boot Hermes again
    (bootstrap, the PM check, imports), which is most of what ``hermes tern`` spends starting."""
    from hermes_cli.main import main

    argv, saved = sys.argv, os.environ.get("HERMES_TUI_DIR")
    sys.argv = [argv[0], "chat", "--tui", *flags]
    if tui_dir:
        os.environ["HERMES_TUI_DIR"] = tui_dir
    else:
        os.environ.pop("HERMES_TUI_DIR", None)
    try:
        code = main()
    except SystemExit as done:
        code = done.code
    finally:
        sys.argv = argv
        if saved is None:
            os.environ.pop("HERMES_TUI_DIR", None)
        else:
            os.environ["HERMES_TUI_DIR"] = saved
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
    code = _chat(flags, str(FRONTEND))
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
    render_hints.register(ctx)
