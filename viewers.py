"""Which live ``hermes tern`` pane shows which conversation, kept in the gateway's memory.

The frontend tells the plugin over its gateway connection (plugin RPC methods):

- ``plugin.hermes-tern.viewer.set`` ``{session_id, stored?, pid, tern}`` when it shows a session (a new
  one, a resume, a reattach after a reconnect). ``tern`` is the pane's Tern variables (``TERN_PANE``…).
- ``plugin.hermes-tern.viewer.clear`` ``{session_id, stored?, pid}`` when it stops showing it (a switch, quit).
- ``plugin.hermes-tern.viewer.shown`` ``{ids}``: whether a live pane shows one of those conversations
  (a restarted pane asks before it resumes its last one).

A gateway restart forgets everything; each pane sets its session again when it reattaches. A pane whose
process died counts for nothing (its pid is checked on every read), as the marker files it replaces did.
``tern_env.py`` reads this state.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any, Optional

from . import processes, sessions

# The variables a Tern pane sets that Tern's CLI reads to find the pane and its window.
TERN_VARS = ("TERN_PANE", "TERN_PANE_SOCKET", "TERN_WINDOW_KEY", "TERN_WINDOW_SOCKET", "TERN_DAEMON_SOCKET")
MAX_VALUE_CHARS = 1024


@dataclass(frozen=True)
class Viewer:
    pid: int
    tern: dict[str, str] = field(default_factory=dict)


_lock = threading.Lock()
# Conversation id (the session's id, and its stored id) -> the panes showing it, the latest one first.
_viewers: dict[str, list[Viewer]] = {}


def _alive(viewer: Optional[Viewer]) -> bool:
    return viewer is not None and processes.running(viewer.pid)


def viewer_of(ids: list[str]) -> Optional[Viewer]:
    """The live pane showing one of ``ids`` (in order), else None."""
    with _lock:
        found = [v for i in ids for v in _viewers.get(i, ())]
    return next((v for v in found if _alive(v)), None)


def _ids(session_id: str, stored: Any) -> list[str]:
    """The ids a pane's claim is kept under: the session's own, and its stored id when that id is of
    the same conversation (its compression lineage), so a client cannot claim another conversation."""
    ids = [session_id]
    if isinstance(stored, str) and stored and stored != session_id:
        if stored in sessions.lineage(session_id):
            ids.append(stored)
    return ids


def _pid(params: dict) -> int:
    pid = params.get("pid")
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        raise ValueError("pid must be the frontend's process id")
    return pid


def _tern(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    return {k: v for k, v in raw.items() if k in TERN_VARS and isinstance(v, str) and v and len(v) <= MAX_VALUE_CHARS}


def set_viewer(params: dict, *, session_id: Optional[str] = None, **_: Any) -> dict[str, Any]:
    if not session_id:
        raise ValueError("viewer.set needs the session_id it shows")
    viewer = Viewer(pid=_pid(params), tern=_tern(params.get("tern")))
    ids = _ids(session_id, params.get("stored"))
    with _lock:
        for i in ids:
            _viewers[i] = [viewer, *(v for v in _viewers.get(i, ()) if v.pid != viewer.pid)]
    return {"ids": ids}


def clear_viewer(params: dict, *, session_id: Optional[str] = None, **_: Any) -> dict[str, Any]:
    """Drops the claim of process ``pid`` only: another pane that shows the session keeps its own."""
    if not session_id:
        raise ValueError("viewer.clear needs the session_id it stops showing")
    pid = _pid(params)
    ids = _ids(session_id, params.get("stored"))
    with _lock:
        for i in ids:
            if left := [v for v in _viewers.get(i, ()) if v.pid != pid]:
                _viewers[i] = left
            else:
                _viewers.pop(i, None)
    return {"ids": ids}


def shown(params: dict, **_: Any) -> dict[str, bool]:
    raw = params.get("ids")
    ids = [i for i in raw if isinstance(i, str) and i][:16] if isinstance(raw, list) else []
    if not ids:
        raise ValueError("viewer.shown needs the ids of a conversation")
    lineage: list[str] = []
    for i in ids:
        lineage += sessions.lineage(i)
    return {"shown": viewer_of([*ids, *lineage]) is not None}


def register(ctx) -> None:
    ctx.register_rpc("viewer.set", set_viewer)
    ctx.register_rpc("viewer.clear", clear_viewer)
    ctx.register_rpc("viewer.shown", shown)
