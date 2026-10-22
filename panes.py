"""A ``hermes tern`` pane keeps its conversation when its program dies.

Tern's session daemon restarts only omp after a crash (omp reports its session file in the
``omp_session_file`` user variable and Tern relaunches ``omp --restore``); every other pane comes
back as a shell with its scrollback. So the pane remembers its conversation itself: the frontend
writes ``plugin-data/hermes-tern/panes/<TERN_PANE>.json`` (``{session_id, cwd, updated_at, pid}``,
frontend/src/session/pane.ts) each time it adopts a session, and removes it when the user quits.

When ``hermes tern`` starts again in that pane with no session flag (``-r``, ``-c``, ``-w``, or the
plugin's own ``--new``), and the file's process is dead, the launcher resumes that conversation as
``hermes chat --tui --resume <root id>`` would: Hermes follows the root to its compression tip and
restores its folder. It does not when:

- the shell runs in another folder than the pane's launch folder or the session's own;
- the session is gone from ``state.db``;
- a live ``hermes tern`` pane shows the conversation (its viewer marker, any id of its compression
  lineage), or another launcher claimed it a moment ago (``panes/claims/<root>.json``, written under
  a lock, so two panes restarting together never both take it).
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Iterator, Mapping, Optional

logger = logging.getLogger(__name__)

# The plugin's own flag: a fresh session in a pane that has one to resume.
NEW_FLAG = "--new"
# `hermes chat` flags that name the session (or a new worktree's): the pane's own does not apply.
SESSION_FLAGS = frozenset({"-r", "--resume", "-c", "--continue", "-w", "--worktree"})
# Tells the frontend its first session is the pane's, resumed after a restart (its notice).
RESTORED_ENV = "HERMES_TERN_RESTORED"
# The folder `hermes tern` started in, before a resume moves to the session's: the pane file records it.
LAUNCH_CWD_ENV = "HERMES_TERN_LAUNCH_CWD"
# Pane files and claims of dead processes older than this are removed.
STALE_S = 30 * 24 * 3600


def _connections():
    from . import connections

    return connections


def _read(path: Path) -> Optional[dict[str, Any]]:
    with contextlib.suppress(OSError, ValueError):
        data = json.loads(path.read_text())
        if isinstance(data, dict):
            return data
    return None


def _write(path: Path, data: dict[str, Any]) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data))
    os.replace(tmp, path)


@contextlib.contextmanager
def _locked(folder: Path) -> Iterator[None]:
    """One launcher at a time decides (POSIX); elsewhere the claim alone guards."""
    try:
        import fcntl
    except ImportError:
        yield
        return
    with open(folder / ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def _real(path: Any) -> str:
    return os.path.realpath(str(path)) if path else ""


def _session(session_id: str) -> Optional[dict[str, Any]]:
    """The session's stored row, or None when it is gone or state.db cannot be read."""
    with contextlib.suppress(Exception):
        from hermes_state import SessionDB

        db = SessionDB(read_only=True)
        try:
            return db.get_session(session_id)
        finally:
            with contextlib.suppress(Exception):
                db.close()
    return None


def _prune(folder: Path, now: float) -> None:
    """Removes pane files and claims whose process died long ago: a pane's id is never reused."""
    conn = _connections()
    for path in [*folder.glob("*.json"), *folder.glob("claims/*.json")]:
        data = _read(path) or {}
        with contextlib.suppress(OSError, TypeError, ValueError):
            if not conn._alive(data.get("pid")) and now - float(data.get("updated_at") or path.stat().st_mtime) > STALE_S:
                path.unlink()


def explicit(flags: list[str]) -> bool:
    """Whether the flags choose the session (or a new worktree) themselves."""
    return any(f in SESSION_FLAGS or f.split("=", 1)[0] in SESSION_FLAGS for f in flags)


def _restorable(pane: str, folder: Path, cwd: str) -> Optional[str]:
    """The root id of the conversation pane ``pane`` showed when its program died, if this launch may take it."""
    conn = _connections()
    record = _read(folder / f"{pane}.json")
    if not record or not isinstance(record.get("session_id"), str) or not record["session_id"]:
        return None
    if conn._alive(record.get("pid")):
        return None  # the pane's program still runs (a `hermes tern` inside it)
    sid = record["session_id"]
    session = _session(sid)
    if not session:
        return None
    if _real(cwd) not in {_real(record.get("cwd")), _real(session.get("cwd"))}:
        return None
    lineage = conn._lineage(sid)
    root = lineage[0] if lineage else sid
    if conn.viewed_by_tern(sid):
        return None
    claim = _read(folder / "claims" / f"{root}.json")
    if claim and claim.get("pid") != os.getpid() and conn._alive(claim.get("pid")):
        return None
    return root


def plan(flags: list[str], env: Optional[Mapping[str, str]] = None, cwd: Optional[str] = None) -> tuple[list[str], Optional[str]]:
    """The flags to run ``hermes chat --tui`` with, and the conversation resumed for the pane (or None).

    ``--new`` is dropped (``hermes chat`` does not know it) and forgets the pane's conversation."""
    env = os.environ if env is None else env
    cwd = os.getcwd() if cwd is None else cwd
    fresh = NEW_FLAG in flags
    flags = [f for f in flags if f != NEW_FLAG]
    pane = (env.get("TERN_PANE") or "").strip()
    if not pane or not pane.isdigit():
        return flags, None
    try:
        folder = _connections()._dir("panes")
        (folder / "claims").mkdir(exist_ok=True)
        with _locked(folder):
            if fresh:
                (folder / f"{pane}.json").unlink(missing_ok=True)
                return flags, None
            if explicit(flags):
                return flags, None
            root = _restorable(pane, folder, cwd)
            if root:
                _write(folder / "claims" / f"{root}.json", {"pid": os.getpid(), "pane": pane, "updated_at": time.time()})
            _prune(folder, time.time())
    except Exception:  # noqa: BLE001 - a broken pane file must never stop the launch
        logger.debug("hermes-tern: no pane restore for %s", pane, exc_info=True)
        return flags, None
    return (["--resume", root, *flags], root) if root else (flags, None)
