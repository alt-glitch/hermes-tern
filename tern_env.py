"""The chat's Tern pane in every process the agent starts, so plain ``tern open`` and ``tern split`` work.

In ``hermes chat`` and the Ink TUI the agent runs in a process the pane started, so its shell
inherits ``TERN_PANE`` and Tern's CLI finds the chat's block. ``hermes tern`` attaches to the
profile's shared gateway instead, which no pane started (or another pane did): its commands would
run without the chat's pane, and ``tern`` would act beside whatever block Tern has focused.

The pane writes its Tern variables into its viewer marker (``plugin-data/hermes-tern/viewers/
<session>.json``, the frontend's ``markViewer``), and this module bridges them the way Hermes
bridges ``HERMES_SESSION_*``:

- one entry per Tern variable joins ``gateway.session_context._VAR_MAP``, the map Hermes copies
  into the env of every child process it spawns (terminal commands, background processes, the
  ``execute_code`` kernel, …). Its value is read at spawn time, in the spawning thread, from the
  marker of the session bound there (``HERMES_SESSION_ID``; a subagent's: the conversation that
  delegated it), so concurrent sessions in one gateway each get their own pane, and a conversation
  resumed in another pane follows it;
- the names join the terminal's per-session list (``BaseEnvironment.
  _snapshot_excluded_passthrough_names``): they stay out of the shared bash snapshot, and survive
  its ``source``, as the bridged ``HERMES_SESSION_*`` do.

A session no live ``hermes tern`` pane shows keeps the gateway's own values: a gateway a pane
started (the Ink TUI's, ``hermes chat``) keeps its pane, as before.

Both hooks are Hermes internals; a plugin API for per-session child env would replace them.
"""

from __future__ import annotations

import contextlib
import json
import os
import time
from typing import Any

# The variables a Tern pane sets that Tern's CLI reads to find the pane and its window.
TERN_VARS = ("TERN_PANE", "TERN_PANE_SOCKET", "TERN_WINDOW_KEY", "TERN_WINDOW_SOCKET", "TERN_DAEMON_SOCKET")
# A spawn reads every variable; one marker read serves them all.
FRESH_S = 1.0

# Session id -> the ids its marker may be under (its delegator's compression lineage), newest first.
_ids: dict[str, list[str]] = {}
_panes: dict[str, tuple[float, dict[str, str]]] = {}


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
    from . import connections

    env: dict[str, str] = {}
    viewers = connections._dir("viewers")
    for sid in _marker_ids(session_id):
        with contextlib.suppress(OSError, ValueError, KeyError, TypeError, AttributeError):
            marker = json.loads((viewers / f"{sid}.json").read_text())
            tern = marker.get("tern") or {}
            if tern.get("TERN_PANE") and connections._alive(marker["pid"]):
                env = {k: str(tern[k]) for k in TERN_VARS if tern.get(k)}
                break
    _panes[session_id] = (now, env)
    return env


class PaneVar:
    """A ``_VAR_MAP`` entry: reads like the session's ContextVars, but resolves the bound session's
    pane when Hermes builds a child's env. A pane's missing variable reads "" so the gateway's own
    value cannot stand in for it; no pane reads the gateway's own value."""

    def __init__(self, name: str) -> None:
        self.name = name

    def get(self, *default: Any) -> Any:
        from gateway.session_context import _UNSET, _VAR_MAP

        sid = _VAR_MAP["HERMES_SESSION_ID"].get()
        with contextlib.suppress(Exception):
            if isinstance(sid, str) and (env := pane_env(sid)):
                return env.get(self.name, "")
        return os.environ.get(self.name, _UNSET)

    def set(self, _value: Any) -> None:
        # Nothing to bind: ``reset_session_vars`` resets every entry, and the value follows the session.
        return None


def install() -> bool:
    """Bridges the Tern variables into every child process Hermes spawns for a session."""
    try:
        from gateway.session_context import _VAR_MAP
        from tools.environments.base import BaseEnvironment
    except Exception:  # noqa: BLE001 - not a gateway with session context: nothing to bridge
        return False
    if "HERMES_SESSION_ID" not in _VAR_MAP:
        return False
    for name in TERN_VARS:
        _VAR_MAP[name] = PaneVar(name)

    excluded = BaseEnvironment._snapshot_excluded_passthrough_names
    if not getattr(excluded, "_tern", False):
        def with_tern(self) -> tuple[str, ...]:
            return tuple(sorted({*excluded(self), *TERN_VARS}))

        with_tern._tern = True
        BaseEnvironment._snapshot_excluded_passthrough_names = with_tern
    return True


def register(_ctx) -> None:
    install()
