"""The chat's Tern pane in every command the agent runs, so plain ``tern open`` and ``tern split`` work.

In ``hermes chat`` and the Ink TUI the agent runs in a process the pane started, so its shell
inherits ``TERN_PANE`` and Tern's CLI finds the chat's block. ``hermes tern`` attaches to the
profile's shared gateway instead, which no pane started (or another pane did): its commands would
run without the chat's pane, and ``tern`` would act beside whatever block Tern has focused.

So the plugin gives each session's commands the Tern variables of the pane that shows it, through
Hermes' public ``ctx.register_session_env``: Hermes calls :func:`pane_env` with the session id each
time it starts a command's process (foreground, background, a Python cell's ``terminal()``). The
pane says which session it shows over plugin RPC (``viewers.py``). The command itself is not
changed, so what the agent wrote, what the approval sheet shows and what runs are the same text.

Concurrent sessions in one gateway each get their own pane, a subagent gets the pane of the
conversation that delegated it, and a conversation resumed in another pane follows it. A session no
live pane shows keeps the gateway's own values.
"""

from __future__ import annotations

import logging
from typing import Optional

from . import sessions, viewers

logger = logging.getLogger(__name__)

TERN_VARS = viewers.TERN_VARS

# Session id -> the ids its pane may be under (its delegator's compression lineage), newest first.
_ids: dict[str, list[str]] = {}


def _viewer_ids(session_id: str) -> list[str]:
    if session_id not in _ids:
        _ids[session_id] = list(reversed(sessions.lineage(sessions.delegator(session_id))))
    return _ids[session_id]


def pane_env(session_id: str) -> dict[str, Optional[str]]:
    """The Tern variables of the live ``hermes tern`` pane showing ``session_id``'s conversation (a
    variable that pane lacks is unset), else {}: the command keeps the gateway's own values."""
    if not session_id:
        return {}
    viewer = viewers.viewer_of([session_id, *_viewer_ids(session_id)])
    if viewer is None or not viewer.tern.get("TERN_PANE"):
        return {}
    return {k: viewer.tern.get(k) for k in TERN_VARS}


def register(ctx) -> None:
    ctx.register_session_env(list(TERN_VARS), pane_env)
