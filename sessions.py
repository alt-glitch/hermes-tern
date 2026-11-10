"""The plugin's reads of Hermes' session database, through ``hermes_state`` (on Hermes' published
plugin import list). This is the one module that imports it.

Every read opens the database read-only. A read that fails (no database yet, a locked file, a
Hermes whose schema differs) answers as if the session had no stored row, so a broken read never
stops a launch or a tool call.
"""

from __future__ import annotations

import contextlib
import json
from typing import Any, Iterator, Optional


@contextlib.contextmanager
def database() -> Iterator[Any]:
    """A read-only ``SessionDB``, closed when the block ends."""
    from hermes_state import SessionDB

    db = SessionDB(read_only=True)
    try:
        yield db
    finally:
        with contextlib.suppress(Exception):
            db.close()


def row(session_id: str) -> Optional[dict[str, Any]]:
    """The session's stored row, or None when it is gone or the database cannot be read."""
    with contextlib.suppress(Exception), database() as db:
        return db.get_session(session_id)
    return None


def lineage(session_id: str) -> list[str]:
    """The conversation's session ids, root first: compression gives a conversation a new id, and the
    pane names the conversation by its root (``stored_session_id``)."""
    if not session_id:
        return []
    with contextlib.suppress(Exception), database() as db:
        ids = db.get_compression_lineage(session_id)
        if ids:
            return [str(i) for i in ids]
    return [session_id]


def _delegated_from(stored: Optional[dict[str, Any]]) -> str:
    """The session that delegated the session of row ``stored`` (core's delegate child: a
    ``_delegate_from`` marker naming its parent, or a ``tool`` session), else ""."""
    stored = stored or {}
    parent = str(stored.get("parent_session_id") or "")
    if not parent:
        return ""
    config = stored.get("model_config")
    if isinstance(config, str):
        with contextlib.suppress(ValueError):
            config = json.loads(config)
    marker = config.get("_delegate_from") if isinstance(config, dict) else None
    return parent if marker == parent or stored.get("source") == "tool" else ""


def delegator(session_id: str) -> str:
    """The top session of a subagent's delegation chain (a nested child's parent is a subagent too),
    else ``session_id`` itself."""
    with contextlib.suppress(Exception), database() as db:
        seen = {session_id}
        while (parent := _delegated_from(db.get_session(session_id))) and parent not in seen:
            seen.add(parent)
            session_id = parent
    return session_id
