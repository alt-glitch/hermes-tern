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

from . import browser_backend, channels, connections, ephemeral_cards, panes, plan_gateway, pull_requests, tern_env

FRONTEND = Path(__file__).resolve().parent / "frontend"
# How much of a channel's commit `hermes tern channels` shows.
SHORT_SHA = 12

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


def _without_session_flags(flags: list[str]) -> list[str]:
    """Drops the flags that pick a session (and a ``-r``/``--resume`` value): a switch names its own."""
    out, skip = [], False
    for f in flags:
        if skip:
            skip = False
            continue
        if f in {"-r", "--resume"}:
            skip = True
            continue
        if f in panes.SESSION_FLAGS or f.split("=", 1)[0] in panes.SESSION_FLAGS or f == panes.NEW_FLAG:
            continue
        out.append(f)
    return out


def _subcommand(flags: list[str]) -> bool:
    """``hermes tern switch NAME [--pane ID]`` and ``hermes tern channels``; True when one ran."""
    if flags[:1] == ["channels"]:
        reg = channels.registry_path()
        chans = channels.load(reg)
        print(f"registry: {reg}")
        for name, chan in sorted(chans.items()):
            alias = f"  (hermes --tui {chan['alias']})" if chan.get("alias") else ""
            print(f"  {name:10} {chan.get('repo', '')}@{str(chan.get('sha', ''))[:SHORT_SHA]}  {chan['dir']}{alias}")
        return True
    if flags[:1] == ["switch"]:
        rest = flags[1:]
        pane = channels.current_pane()
        if "--pane" in rest:
            i = rest.index("--pane")
            pane = rest[i + 1] if i + 1 < len(rest) else ""
            rest = rest[:i] + rest[i + 2:]
        if len(rest) != 1 or not pane.strip().isdigit():
            raise SystemExit("usage: hermes tern switch CHANNEL [--pane TERN_PANE_ID]")
        req = channels.request_switch(rest[0], pane.strip())
        print(f"hermes tern: pane {pane} -> channel {rest[0]} (session {req['session_id']})")
        return True
    return False


def _run(args: argparse.Namespace, channel: str | None = None) -> None:
    # An explicit opt-out is the ordinary Ink TUI, even inside a real Tern pane.
    force_ink = os.environ.get("HERMES_TERN", "").strip().lower() in {"0", "false", "off", "no"}
    flags = [a for a in args.tui_args if a != "--"]
    if _subcommand(flags):
        return
    flags, chosen = channels.take_channel(flags)
    channel = chosen or channel or channels.default_channel()
    front = channels.frontend_dir(channel) if channel and not force_ink else FRONTEND
    bundle = front / "dist" / "entry.js"
    if not force_ink and not bundle.is_file():
        print(f"hermes tern: {bundle} is missing; reinstall the plugin", file=sys.stderr)
        sys.exit(1)
    # `hermes -w tern`: the top-level flag lands on `args`, not in tui_args; Hermes' TUI launcher is what
    # makes the worktree and points the session, HERMES_CWD and TERMINAL_CWD at it.
    if getattr(args, "worktree", False) and not {"-w", "--worktree"} & set(flags):
        flags = ["--worktree", *flags]
    # Read before a resume moves to the session's folder: the pane file records where the pane launched.
    env = {panes.LAUNCH_CWD_ENV: os.getcwd()}
    flags, restored = panes.plan(flags)
    if restored:
        env[panes.RESTORED_ENV] = restored
    code = _chat(flags, None if force_ink else str(front), env)
    if not force_ink and code == NO_TSP_EXIT:
        print("hermes tern: this terminal does not speak the Tern Surface Protocol; "
              "starting the regular TUI", file=sys.stderr)
        code = _chat(flags, None, env)
    # `hermes tern switch`: this pane's frontend was stopped to come back on another channel.
    while not force_ink and (switch := channels.pending_switch()):
        front = channels.frontend_dir(switch["channel"])
        flags = ["--resume", switch["session_id"], *_without_session_flags(flags)]
        env.pop(panes.RESTORED_ENV, None)
        code = _chat(flags, str(front), env)
    sys.exit(code)


def register(ctx) -> None:
    ctx.register_cli_command(
        name="tern", help="Chat in Tern's native UI (falls back to the regular TUI elsewhere)",
        setup_fn=_setup, handler_fn=_run,
        description="Runs `hermes chat --tui` with the Tern frontend; every `hermes chat` flag works. "
                    "--channel NAME picks a frontend channel; `switch NAME` moves this pane to one live.")
    # Channel aliases from the shared registry: `hermes --tui mytern` is `hermes tern --channel main`.
    for alias, channel in channels.aliases().items():
        ctx.register_cli_command(
            name=alias, help=f"hermes tern on frontend channel {channel!r}",
            setup_fn=_setup, handler_fn=lambda args, _c=channel: _run(args, _c),
            description=f"`hermes tern --channel {channel}`; every `hermes chat` flag works.")
    # The chart rules of background processes (frontend/src/processes/widgets, widget_author.py):
    # its own `auxiliary.tern_charts` config block and model picker entry.
    ctx.register_auxiliary_task(
        "tern_charts", display_name="Tern job charts",
        description="Writes the rules behind a background process's live chart in `hermes tern`, once per process.")
    # Independent task for opt-in settled-table classification; no gateway RPC.
    ctx.register_auxiliary_task(
        "table_charts", display_name="Tern table charts",
        description="Selects bar, line or no visualization for a settled Markdown table in `hermes tern`.")
    pull_requests.register(ctx)
    ephemeral_cards.register(ctx)
    connections.register(ctx)
    tern_env.register(ctx)
    # Gateway RPCs are optional: older Hermes still launches and uploads normally.
    if callable(getattr(ctx, 'register_gateway_method', None)):
        from . import media_backend
        media_backend.register(ctx)
    browser_backend.register(ctx)
    # Older Hermes has no public gateway registration; do not synthesize
    # a JSON-RPC method or change its pinned runtime.
    if callable(getattr(ctx, "register_gateway_method", None)):
        from . import gateway_operations
        gateway_operations.register(ctx)
    plan_gateway.register(ctx)
    from . import talk_backend
    talk_backend.register(ctx)
