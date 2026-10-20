"""The chat's Tern pane in every command the agent runs, so plain ``tern open`` and ``tern split`` work.

In ``hermes chat`` and the Ink TUI the agent runs in a process the pane started, so its shell
inherits ``TERN_PANE`` and Tern's CLI finds the chat's block. ``hermes tern`` attaches to the
profile's shared gateway instead, which no pane started (or another pane did): its commands would
run without the chat's pane, and ``tern`` would act beside whatever block Tern has focused.

The pane writes its Tern variables into its viewer marker (``plugin-data/hermes-tern/viewers/
<session>.json``, the frontend's ``markViewer``). A ``tool_request`` middleware (a public plugin
API) prefixes each ``terminal`` command of a session such a pane shows (in the foreground, in the
background, and the ones a Python cell's ``terminal()`` runs) with an ``export`` of that pane's
variables, read when the call is made: concurrent sessions in one gateway each get their own
pane, a subagent gets the pane of the conversation that delegated it, and a conversation resumed
in another pane follows it. The middleware changes only what runs; the model's history keeps the
command as it wrote it, and the frontend leaves the prefix out of what it shows.

A session no live pane shows keeps the gateway's own values: a gateway a pane started (the Ink
TUI's, ``hermes chat``) keeps its pane, as before. A session that had a pane and lost it gets the
gateway's values back (or none), so a stale pane does not linger in its shell.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import shlex
import time
from typing import Any

logger = logging.getLogger(__name__)

# The variables a Tern pane sets that Tern's CLI reads to find the pane and its window.
TERN_VARS = ("TERN_PANE", "TERN_PANE_SOCKET", "TERN_WINDOW_KEY", "TERN_WINDOW_SOCKET", "TERN_DAEMON_SOCKET")
# The tools whose `command` runs in the session's shell.
SHELL_TOOLS = frozenset({"terminal"})
# Calls in a burst read one marker.
FRESH_S = 1.0
# What the prefix starts with; the frontend matches it to leave the prefix out of what it shows.
MARK = "export TERN_PANE="

# Session id -> the ids its marker may be under (its delegator's compression lineage), newest first.
_ids: dict[str, list[str]] = {}
_panes: dict[str, tuple[float, dict[str, str]]] = {}
# Sessions whose commands were given a pane, so the pane can be taken back when it goes.
_given: set[str] = set()


def _marker_ids(session_id: str) -> list[str]:
    if session_id not in _ids:
        from . import connections, pull_requests

        _ids[session_id] = list(reversed(connections._lineage(pull_requests._delegator(session_id))))
    return _ids[session_id]


def pane_env(session_id: str) -> dict[str, str]:
    """The Tern variables of the live ``hermes tern`` pane showing ``session_id``'s conversation, else {}."""
    if not session_id:
        return {}
    now = time.monotonic()
    if (hit := _panes.get(session_id)) and now - hit[0] < FRESH_S:
        return hit[1]
    tern = (marker := viewer(session_id)) and marker.get("tern") or {}
    env = {k: str(tern[k]) for k in TERN_VARS if tern.get(k)} if tern.get("TERN_PANE") else {}
    _panes[session_id] = (now, env)
    return env


def viewer(session_id: str) -> dict[str, Any] | None:
    """The viewer marker of the live ``hermes tern`` pane showing ``session_id``'s conversation, else None."""
    from . import connections

    viewers = connections._dir("viewers")
    for sid in _marker_ids(session_id) if session_id else ():
        with contextlib.suppress(OSError, ValueError, KeyError, TypeError, AttributeError):
            marker = json.loads((viewers / f"{sid}.json").read_text())
            if connections._alive(marker["pid"]):
                return marker
    return None


def _assign(env: dict[str, str]) -> str:
    """`export` of the set variables and `unset` of the others; starts with :data:`MARK` when the pane is set."""
    names = sorted(TERN_VARS, key=lambda k: k != "TERN_PANE")
    parts = []
    if present := [k for k in names if env.get(k)]:
        parts.append("export " + " ".join(f"{k}={shlex.quote(env[k])}" for k in present) + ";")
    if absent := [k for k in names if not env.get(k)]:
        parts.append("unset " + " ".join(absent) + ";")
    return " ".join(parts) + " "


def prefix(session_id: str) -> str:
    """What goes before a command of ``session_id``: its pane's variables, the gateway's own once
    a pane it had is gone, else nothing."""
    if env := pane_env(session_id):
        _given.add(session_id)
        return _assign(env)
    if session_id in _given:
        _given.discard(session_id)
        return _assign({k: os.environ[k] for k in TERN_VARS if os.environ.get(k)})
    return ""


def tool_request(tool_name: str = "", args: Any = None, session_id: str = "", **_: Any) -> dict[str, Any] | None:
    """``tool_request`` middleware: a shell command runs with the session's pane."""
    if tool_name not in SHELL_TOOLS or os.name == "nt" or not isinstance(args, dict):
        return None
    command = args.get("command")
    if not isinstance(command, str) or not command.strip():
        return None
    try:
        head = prefix(session_id)
    except Exception:  # noqa: BLE001 - a broken marker must never stop a command
        logger.debug("hermes-tern: no pane for %s", session_id, exc_info=True)
        return None
    return {"args": {**args, "command": head + command}} if head else None


def register(ctx) -> None:
    ctx.register_middleware("tool_request", tool_request)
