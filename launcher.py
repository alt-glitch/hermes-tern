"""``hermes tern [flags]``: tern's own launcher.

It parses its flags, picks the session (``-r``, ``-c``, or the pane's own after a crash, ``panes.py``),
and runs ``node frontend/dist/entry.js`` as a child with the terminal inherited. The frontend dials
the profile's gateway itself (``hermes gateway attach --json``, frontend/src/hermes/connect.ts) with
the command it is handed in ``HERMES_TERN_HERMES``, so it uses this install and this profile.

What the frontend needs goes in ``HERMES_TERN_*`` variables. The launch policy (model, provider,
toolsets, skills, yolo, …) goes in ``HERMES_TERN_CREATE`` as the fields of the gateway's public
``session.create``.

When the terminal does not answer the Tern Surface Protocol handshake, the frontend exits
:data:`NO_TSP_EXIT`. The launcher then says so and exits: ``hermes tern`` runs only in Tern.

Around the frontend it does what Hermes' own chat launcher does, through Hermes' published
functions (:func:`hermes_api`): the ``-w`` worktree before and after, and the "resume with" summary
after a quit. The frontend writes the session it shows to the file named in
``HERMES_TERN_SESSION_FILE``, because the pane's own record (``panes.py``) is removed on a quit.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

from . import panes, pull_requests, sessions

FRONTEND = Path(__file__).resolve().parent / "frontend"

# frontend/src/entry.ts NO_TSP: the terminal never answered the TSP handshake.
NO_TSP_EXIT = 75
# V8 heap for long sessions, as Hermes gives its own TUI (unless NODE_OPTIONS sets one).
HEAP_MB = 8192
# What `-c` continues, in order: a session a frontend created on the shared gateway (stored as
# source `local`, created by `tui`), then a classic CLI session.
CONTINUE_SOURCES = ({"source": ["tui", "local"], "local_created_sources": ["tui"]},
                    {"source": ["cli", "local"], "local_created_sources": ["cli"]})
# The launch variables of an outer `hermes tern`; this launch sets its own.
OWN_ENV = ("HERMES_TERN_HERMES", "HERMES_TERN_SESSION_FILE", "HERMES_TERN_RESUME", "HERMES_TERN_QUERY",
           "HERMES_TERN_IMAGE", "HERMES_TERN_CWD", "HERMES_TERN_SESSION_CWD", "HERMES_TERN_CREATE", "HERMES_TERN_TOOL_PROGRESS",
           "HERMES_TERN_GITHUB_ENTERPRISE_HOSTS", panes.RESTORED_ENV, panes.LAUNCH_CWD_ENV)
# Exit codes of a quit (`/quit`, Ctrl+C): the summary is printed and a dirty `-w` tree is asked about.
QUIT_CODES = (0, 130)
TOO_OLD = "hermes tern: this Hermes is older than hermes tern needs. Run `hermes update`."

# Launch flags a shell can export instead of passing (as `hermes chat` reads them).
ENV_FLAGS = {"yolo": "HERMES_YOLO_MODE", "ignore_rules": "HERMES_IGNORE_RULES", "accept_hooks": "HERMES_ACCEPT_HOOKS"}

S = argparse.SUPPRESS
# (flags, argparse options). SUPPRESS defaults: a flag left out keeps the value Hermes' top-level
# parser put on the namespace (`hermes -m x tern`).
FLAGS: list[tuple[tuple[str, ...], dict[str, Any]]] = [
    (("-r", "--resume"), dict(metavar="SESSION", help="resume a session by id or title")),
    (("-c", "--continue"), dict(dest="continue_last", nargs="?", const=True, metavar="NAME",
                                help="continue the last session here, or the one titled NAME")),
    (("-m", "--model"), dict(help="the model for a new session")),
    (("--provider",), dict(help="the provider for a new session")),
    (("-t", "--toolsets"), dict(help="comma-separated toolsets")),
    (("-s", "--skills"), dict(action="append", help="skills to preload (repeat or comma-separate)")),
    (("-q", "--query"), dict(help="the first prompt")),
    (("--image",), dict(metavar="PATH", help="an image to attach to the first prompt")),
    (("--max-turns",), dict(dest="max_turns", metavar="N", help="the turn limit of a new session")),
    (("--yolo",), dict(action="store_true", help="skip command approvals")),
    (("--ignore-rules",), dict(dest="ignore_rules", action="store_true",
                               help="skip AGENTS.md, SOUL.md, memory and preloaded skills")),
    (("--checkpoints",), dict(action="store_true", help="file checkpoints for /rollback")),
    (("--pass-session-id",), dict(dest="pass_session_id", action="store_true", help="tell the model its session id")),
    (("--accept-hooks",), dict(dest="accept_hooks", action="store_true", help="run shell hooks without asking")),
    (("-v", "--verbose"), dict(action="store_true", help="verbose tool progress")),
    (("-Q", "--quiet"), dict(action="store_true", help="no tool progress")),
    (("--new",), dict(action="store_true",
                             help="a new session, where the pane would resume its last one")),
    (("-w", "--worktree"), dict(action="store_true", help="run the session in a new git worktree of this repository")),
]


def setup(parser: argparse.ArgumentParser) -> None:
    for names, options in FLAGS:
        parser.add_argument(*names, default=S, **options)


def _truthy(value: Optional[str]) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _opt(args: argparse.Namespace, name: str) -> Any:
    return getattr(args, name, None)


def _skills(args: argparse.Namespace) -> list[str]:
    raw = _opt(args, "skills") or []
    items = raw if isinstance(raw, (list, tuple)) else [raw]
    seen: dict[str, None] = {}
    for item in items:
        for name in str(item).replace("\n", ",").split(","):
            if name.strip():
                seen.setdefault(name.strip(), None)
    return list(seen)


# ── The session to open ──────────────────────────────────────────────────────────────────────


def resolve_session(name_or_id: str) -> Optional[str]:
    """The id of the session ``name_or_id`` names (an id, a unique id prefix such as the one the quit
    summary prints, or a title), at its compression tip; None when none does."""
    with contextlib.suppress(Exception), sessions.database() as db:
        found = db.resolve_session_id(name_or_id) or db.resolve_session_by_title(name_or_id)
        if found:
            with contextlib.suppress(Exception):
                found = db.get_compression_tip(found) or found
        return found
    return None


def _workspace() -> str:
    """The git repository this folder is in, else the folder: where `-c` looks first."""
    with contextlib.suppress(Exception):
        top = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, timeout=5, check=False)
        if top.returncode == 0 and top.stdout.strip():
            return os.path.abspath(top.stdout.strip())
    return os.getcwd()


def latest_session() -> Optional[str]:
    """The last session of this workspace, else the last one anywhere."""
    with contextlib.suppress(Exception), sessions.database() as db:
        workspace = _workspace()
        # This workspace first, for either kind of session; only then anywhere.
        for scope in ({"workspace_key": workspace}, {}):
            for sources in CONTINUE_SOURCES:
                found = db.search_sessions(limit=1, skip_launch_stubs=True, **sources, **scope)
                if found:
                    return found[0]["id"]
    return None


def _session_cwd(session_id: str) -> Optional[str]:
    with contextlib.suppress(Exception), sessions.database() as db:
        cwd = ((db.get_session(session_id) or {}).get("cwd") or "").strip()
        return cwd if cwd and os.path.isdir(cwd) else None
    return None


def pick_session(args: argparse.Namespace) -> Optional[str]:
    """``-r`` (kept as typed when it names nothing: the frontend then says the session is not found), or ``-c``."""
    if resume := _opt(args, "resume"):
        return resolve_session(resume) or resume
    named = _opt(args, "continue_last")
    if isinstance(named, str):
        found = resolve_session(named)
        if not found:
            print(f"hermes tern: no session titled or with id {named!r}", file=sys.stderr)
            sys.exit(1)
        return found
    if named:
        found = latest_session()
        if not found:
            print("hermes tern: no previous session to continue; `hermes sessions list` shows them", file=sys.stderr)
            sys.exit(1)
        return found
    return None


# ── What the frontend is handed ──────────────────────────────────────────────────────────────


def hermes_api() -> SimpleNamespace:
    """Hermes' published launcher functions. An older Hermes lacks them: one line, exit 1."""
    try:
        from hermes_cli.chat_launch import hermes_command, print_exit_summary
        from hermes_cli.gateway_chat import shell_client_env
        from hermes_cli.session_worktree import create, finish, restore
    except ImportError:
        print(TOO_OLD, file=sys.stderr)
        sys.exit(1)
    return SimpleNamespace(shell_client_env=shell_client_env, hermes_command=hermes_command,
                           print_exit_summary=print_exit_summary, create_worktree=create,
                           restore_worktree=restore, finish_worktree=finish)


def create_options(args: argparse.Namespace, client_env: dict[str, str]) -> dict[str, Any]:
    """The launch policy as ``session.create`` fields (the shared gateway freezes them with a new session)."""
    options: dict[str, Any] = {}
    for field in ("model", "provider"):
        if value := _opt(args, field):
            options[field] = value
    if toolsets := _opt(args, "toolsets"):
        options["toolsets"] = [t.strip() for t in str(toolsets).split(",") if t.strip()]
    if skills := _skills(args):
        options["skills"] = skills
    if (turns := _opt(args, "max_turns")) is not None:
        options["max_turns"] = int(turns) if str(turns).lstrip("-").isdigit() else str(turns).strip()
    for field in ("yolo", "ignore_rules", "checkpoints", "pass_session_id", "accept_hooks"):
        if _opt(args, field) or _truthy(os.environ.get(ENV_FLAGS.get(field, ""))):
            options[field] = True
    if client_env:
        options["client_env"] = client_env
    return options


def _local_terminal() -> bool:
    """Whether the profile runs commands on this machine: a new session then starts in this folder."""
    with contextlib.suppress(Exception):
        from hermes_cli.config import load_config

        return str(((load_config() or {}).get("terminal") or {}).get("backend") or "local") == "local"
    return True


def node_binary() -> Optional[str]:
    """Node as Hermes finds it for its TUI: an explicit ``HERMES_NODE``, then Hermes' managed runtime, then PATH."""
    explicit = os.environ.get("HERMES_NODE")
    if explicit and os.path.isfile(explicit) and os.access(explicit, os.X_OK):
        return explicit
    with contextlib.suppress(Exception):
        from pm import ensure

        if found := shutil.which("node", path=ensure("node").env["PATH"]):
            return found
    return shutil.which("node")


def frontend_env(args: argparse.Namespace, resume: Optional[str], restored: Optional[str], launch_cwd: str,
                 hermes: SimpleNamespace, session_file: str) -> dict[str, str]:
    from hermes_constants import get_hermes_home

    env = {k: v for k, v in os.environ.items() if k not in OWN_ENV}
    cwd = os.getcwd()
    env.update({
        "HERMES_HOME": str(get_hermes_home()),
        "HERMES_TERN_HERMES": json.dumps(hermes.hermes_command()),
        "HERMES_TERN_SESSION_FILE": session_file,
        "HERMES_TERN_CWD": cwd,
        "HERMES_TERN_CREATE": json.dumps(create_options(args, hermes.shell_client_env())),
        # The only hosts besides github.com the frontend sends a GitHub token to. Always set, so a
        # value inherited from the shell never widens the list.
        "HERMES_TERN_GITHUB_ENTERPRISE_HOSTS": ",".join(pull_requests.enterprise_hosts()),
        panes.LAUNCH_CWD_ENV: launch_cwd,
        "NODE_ENV": env.get("NODE_ENV") or "production",
    })
    if _local_terminal():
        env["HERMES_TERN_SESSION_CWD"] = cwd
    for key, value in (("HERMES_TERN_RESUME", resume), ("HERMES_TERN_QUERY", _opt(args, "query")),
                       ("HERMES_TERN_IMAGE", _opt(args, "image")), (panes.RESTORED_ENV, restored),
                       ("HERMES_TERN_TOOL_PROGRESS",
                        "verbose" if _opt(args, "verbose") else "off" if _opt(args, "quiet") else None)):
        if value:
            env[key] = str(value)
    tokens = env.get("NODE_OPTIONS", "").split()
    if not any(t.startswith("--max-old-space-size=") for t in tokens):
        tokens.append(f"--max-old-space-size={HEAP_MB}")
    env["NODE_OPTIONS"] = " ".join(tokens)
    return env


def _shown_session(session_file: str) -> Optional[str]:
    """The session the frontend showed last, from the file it writes on every change."""
    with contextlib.suppress(OSError, ValueError, AttributeError):
        return str(json.loads(Path(session_file).read_text()).get("session_id") or "").strip() or None
    return None


def run(args: argparse.Namespace) -> None:
    bundle = FRONTEND / "dist" / "entry.js"
    if not bundle.is_file():
        print(f"hermes tern: {bundle} is missing; reinstall the plugin", file=sys.stderr)
        sys.exit(1)
    hermes = hermes_api()
    if image := _opt(args, "image"):
        # Read here: a resume may move to the session's folder.
        args.image = os.path.abspath(os.path.expanduser(image))
    launch_cwd = os.getcwd()
    resume = pick_session(args)
    restored = panes.plan(fresh=bool(_opt(args, "new")), explicit=bool(resume))
    resume = restored or resume
    worktree = None
    if _opt(args, "worktree"):
        # As `hermes --tui -w`: a new tree for this launch, also on a resume (which then restores nothing).
        worktree = hermes.create_worktree()
        if not worktree:
            sys.exit(1)
        os.chdir(worktree["path"])
    elif resume:
        # A resumed session whose `-w` tree an earlier quit removed gets it back before its folder is read.
        hermes.restore_worktree(resume)
        # A resumed session opens in its own folder, as `hermes chat --resume` does.
        if (cwd := _session_cwd(resume)) and os.path.realpath(cwd) != os.path.realpath(launch_cwd):
            os.chdir(cwd)
    node = node_binary()
    if not node:
        print("hermes tern: Node.js was not found; install it from https://nodejs.org (`hermes doctor` shows how)",
              file=sys.stderr)
        sys.exit(1)
    fd, session_file = tempfile.mkstemp(prefix="hermes-tern-session-", suffix=".json")
    os.close(fd)
    env = frontend_env(args, resume, restored, launch_cwd, hermes, session_file)
    try:
        code = subprocess.call([node, "--expose-gc", str(bundle)], env=env)
    except KeyboardInterrupt:
        code = 130
    shown = _shown_session(session_file) or resume
    with contextlib.suppress(OSError):
        os.unlink(session_file)
    if code in QUIT_CODES and shown:
        hermes.print_exit_summary(shown, command="hermes tern")
    if worktree:
        hermes.finish_worktree(worktree, shown, ask=code in QUIT_CODES)
    if code == NO_TSP_EXIT:
        print("hermes tern: this terminal did not answer the Tern Surface Protocol, so it is not a Tern pane "
              "this program can draw in. Run `hermes tern` in Tern (https://stencil.so/tern), or use `hermes chat`.",
              file=sys.stderr)
        code = 1
    sys.exit(code)
