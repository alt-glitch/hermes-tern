"""``hermes tern [flags]``: tern's own launcher.

It parses its flags, picks the session (``-r``, ``-c``, or the pane's own after a crash, ``panes.py``),
and runs ``node frontend/dist/entry.js`` as a child with the terminal inherited. The frontend dials
the profile's gateway itself (``hermes gateway attach --json``, frontend/src/hermes/connect.ts) with
the command it is handed in ``HERMES_TERN_HERMES``, so it uses this install and this profile.

What the frontend needs goes in ``HERMES_TERN_*`` variables. The launch policy (model, provider,
toolsets, skills, yolo, …) goes in ``HERMES_TERN_CREATE`` as the fields of the gateway's public
``session.create``.

When the terminal does not answer the Tern Surface Protocol handshake, the frontend exits
:data:`NO_TSP_EXIT`, and the launcher runs ``hermes chat --tui`` with the same flags instead.

Not supported, for want of a public API: ``-w``/``--worktree`` (Hermes' worktree setup and its exit
choice), and the "resume with" summary Hermes prints when its TUI exits.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

from . import panes, pull_requests

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
OWN_ENV = ("HERMES_TERN_HERMES", "HERMES_TERN_RESUME", "HERMES_TERN_QUERY", "HERMES_TERN_IMAGE", "HERMES_TERN_CWD",
           "HERMES_TERN_SESSION_CWD", "HERMES_TERN_CREATE", "HERMES_TERN_TOOL_PROGRESS",
           "HERMES_TERN_GITHUB_ENTERPRISE_HOSTS", panes.RESTORED_ENV, panes.LAUNCH_CWD_ENV)
# `session.create`'s `client_env`: the toolchain and behaviour names a shell-launched client sends
# (the gateway filters them again against its own rules and secret policy).
CLIENT_ENV_NAMES = ("PATH", "VIRTUAL_ENV", "GOPATH", "GOROOT", "CARGO_HOME", "RUSTUP_HOME", "JAVA_HOME",
                    "HERMES_EPHEMERAL_SYSTEM_PROMPT", "HERMES_PREFILL_MESSAGES_FILE", "HERMES_INFERENCE_PROVIDER",
                    "HERMES_ENABLE_PROJECT_PLUGINS")
CLIENT_ENV_PREFIXES = ("CONDA_", "NODE_", "NVM_", "PYENV_")
SECRET_WORDS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "AUTH", "CREDENTIAL", "COOKIE", "SESSION")

S = argparse.SUPPRESS
# (flags, argparse options, the `hermes chat` flag it maps back to). SUPPRESS defaults: a flag left
# out keeps the value Hermes' top-level parser put on the namespace (`hermes -m x tern`).
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
    ((panes.NEW_FLAG,), dict(dest="new", action="store_true",
                             help="a new session, where the pane would resume its last one")),
    (("-w", "--worktree"), dict(action="store_true", help="not supported in `hermes tern` yet")),
]


def setup(parser: argparse.ArgumentParser) -> None:
    for names, options in FLAGS:
        parser.add_argument(*names, default=S, **options)


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


def chat_flags(args: argparse.Namespace) -> list[str]:
    """The flags as ``hermes chat`` takes them (the NO_TSP fallback, and what ``panes.plan`` reads)."""
    flags: list[str] = []
    for names, options in FLAGS:
        dest = options.get("dest") or names[-1].lstrip("-").replace("-", "_")
        value = _opt(args, dest)
        if dest == "skills":
            flags += [f"--skills={','.join(_skills(args))}"] if _skills(args) else []
        elif value is True:
            flags.append(names[-1])
        elif value not in (None, False):
            flags.append(f"{names[-1]}={value}")
    return flags


# ── The session to open ──────────────────────────────────────────────────────────────────────


@contextlib.contextmanager
def _db():
    from hermes_state import SessionDB

    db = SessionDB(read_only=True)
    try:
        yield db
    finally:
        with contextlib.suppress(Exception):
            db.close()


def resolve_session(name_or_id: str) -> Optional[str]:
    """The id of the session ``name_or_id`` names (an id or a title), at its compression tip; None when none does."""
    with contextlib.suppress(Exception), _db() as db:
        session = db.get_session(name_or_id)
        found = session["id"] if session else db.resolve_session_by_title(name_or_id)
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
    with contextlib.suppress(Exception), _db() as db:
        workspace = _workspace()
        for sources in CONTINUE_SOURCES:
            for scope in ({"workspace_key": workspace}, {}):
                found = db.search_sessions(limit=1, skip_launch_stubs=True, **sources, **scope)
                if found:
                    return found[0]["id"]
    return None


def _session_cwd(session_id: str) -> Optional[str]:
    with contextlib.suppress(Exception), _db() as db:
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


def hermes_command() -> dict[str, Any]:
    """How to run this Hermes as a command (``hermes gateway attach``, a sidebar's ``hermes tern``):
    this interpreter on this checkout, so the install and its packages are the ones running now."""
    import hermes_cli.config

    root = str(Path(hermes_cli.config.__file__).resolve().parent.parent)
    path = [root, *[p for p in os.environ.get("PYTHONPATH", "").split(os.pathsep) if p and p != root]]
    return {"argv": [sys.executable, "-m", "hermes_cli.main"], "env": {"PYTHONPATH": os.pathsep.join(path)}}


def client_env(environ: Optional[dict[str, str]] = None) -> dict[str, str]:
    """The shell's toolchain and behaviour values for ``session.create``'s ``client_env``."""
    environ = dict(os.environ if environ is None else environ)
    extra: set[str] = set()
    with contextlib.suppress(Exception):
        from hermes_cli.config import load_config

        terminal = (load_config() or {}).get("terminal") or {}
        extra = {n.strip() for n in terminal.get("client_env_passthrough") or [] if isinstance(n, str) and n.strip()}

    def travels(name: str) -> bool:
        if name in CLIENT_ENV_NAMES:
            return True
        if any(word in name.upper() for word in SECRET_WORDS) or name.startswith("HERMES_"):
            return False
        return name in extra or name.startswith(CLIENT_ENV_PREFIXES)

    return {k: v for k, v in environ.items() if isinstance(v, str) and travels(k)}


def create_options(args: argparse.Namespace) -> dict[str, Any]:
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
        if _opt(args, field):
            options[field] = True
    if env := client_env():
        options["client_env"] = env
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


def frontend_env(args: argparse.Namespace, resume: Optional[str], restored: Optional[str], launch_cwd: str) -> dict[str, str]:
    from hermes_constants import get_hermes_home

    env = {k: v for k, v in os.environ.items() if k not in OWN_ENV}
    cwd = os.getcwd()
    env.update({
        "HERMES_HOME": str(get_hermes_home()),
        "HERMES_TERN_HERMES": json.dumps(hermes_command()),
        "HERMES_TERN_CWD": cwd,
        "HERMES_TERN_CREATE": json.dumps(create_options(args)),
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


def fallback(flags: list[str]) -> int:
    """``hermes chat --tui FLAGS``, the regular TUI, as a process of this same install and profile."""
    from hermes_constants import get_hermes_home

    command = hermes_command()
    env = {k: v for k, v in os.environ.items() if k not in OWN_ENV}
    env.update(command["env"], HERMES_HOME=str(get_hermes_home()))
    try:
        return subprocess.call([*command["argv"], "chat", "--tui", *flags], env=env)
    except KeyboardInterrupt:
        return 130


def run(args: argparse.Namespace) -> None:
    bundle = FRONTEND / "dist" / "entry.js"
    if not bundle.is_file():
        print(f"hermes tern: {bundle} is missing; reinstall the plugin", file=sys.stderr)
        sys.exit(1)
    if _opt(args, "worktree"):
        print("hermes tern: --worktree is not supported yet (Hermes has no public API to make and keep the worktree); "
              "use `hermes chat --tui --worktree`", file=sys.stderr)
        sys.exit(2)
    if image := _opt(args, "image"):
        # Read here: a resume may move to the session's folder.
        args.image = os.path.abspath(os.path.expanduser(image))
    launch_cwd = os.getcwd()
    resume = pick_session(args)
    flags = chat_flags(args)
    if resume:
        flags = [f for f in flags if not f.startswith(("--resume=", "--continue"))]
        flags = ["--resume", resume, *flags]
    flags, restored = panes.plan(flags)
    resume = restored or resume
    # A resumed session opens in its own folder, as `hermes chat --resume` does.
    if resume and (cwd := _session_cwd(resume)) and os.path.realpath(cwd) != os.path.realpath(launch_cwd):
        os.chdir(cwd)
    node = node_binary()
    if not node:
        print("hermes tern: Node.js was not found; install it from https://nodejs.org (`hermes doctor` shows how), "
              "or run `hermes chat --tui`", file=sys.stderr)
        sys.exit(1)
    env = frontend_env(args, resume, restored, launch_cwd)
    try:
        code = subprocess.call([node, "--expose-gc", str(bundle)], env=env)
    except KeyboardInterrupt:
        code = 130
    if code == NO_TSP_EXIT:
        print("hermes tern: this terminal does not speak the Tern Surface Protocol; starting the regular TUI",
              file=sys.stderr)
        code = fallback(flags)
    sys.exit(code)
