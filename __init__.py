"""Hermes for Tern.

``hermes tern [flags]`` runs ``hermes --tui [flags]`` with ``HERMES_TUI_DIR`` pointing at this
plugin's prebuilt frontend (``frontend/dist/entry.js``), so Hermes' own TUI launcher keeps doing
everything else: profile, cwd, resume, worktree, the gateway attach and the exit summary. The
frontend exits ``NO_TSP_EXIT`` when the terminal does not answer the Tern Surface Protocol
handshake; the Ink TUI then runs in its place.
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path

FRONTEND = Path(__file__).resolve().parent / "frontend"

# frontend/src/entry.ts NO_TSP: the terminal never answered the TSP handshake.
NO_TSP_EXIT = 75


def _setup(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "tui_args", nargs=argparse.REMAINDER, metavar="FLAGS",
        help="flags for `hermes --tui`, e.g. --resume ID, -c, --model NAME, --worktree")


def _wait(argv: list[str], env: dict) -> int:
    proc = subprocess.Popen(argv, env=env)
    while True:
        try:
            return proc.wait()
        except KeyboardInterrupt:
            # The TUI owns Ctrl-C in raw mode; a stray SIGINT must not orphan it.
            continue


def _run(args: argparse.Namespace) -> None:
    bundle = FRONTEND / "dist" / "entry.js"
    if not bundle.is_file():
        print(f"hermes tern: {bundle} is missing; reinstall the plugin", file=sys.stderr)
        sys.exit(1)
    flags = [a for a in args.tui_args if a != "--"]
    hermes = [sys.executable, "-m", "hermes_cli.main", "--tui", *flags]
    code = _wait(hermes, {**os.environ, "HERMES_TUI_DIR": str(FRONTEND)})
    if code == NO_TSP_EXIT:
        print("hermes tern: this terminal does not speak the Tern Surface Protocol; "
              "starting the regular TUI", file=sys.stderr)
        code = _wait(hermes, dict(os.environ))
    sys.exit(code)


def register(ctx) -> None:
    ctx.register_cli_command(
        name="tern", help="Chat in Tern's native UI (falls back to the regular TUI elsewhere)",
        setup_fn=_setup, handler_fn=_run,
        description="Runs `hermes --tui` with the Tern frontend. Every --tui flag works.")
