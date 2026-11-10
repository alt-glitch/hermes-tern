"""A ``hermes tern`` pane keeps its conversation when its program dies.

Tern's session daemon restarts only omp after a crash (omp reports its session file in the
``omp_session_file`` user variable and Tern relaunches ``omp --restore``); every other pane comes
back as a shell with its scrollback. So the pane remembers its conversation itself: the frontend
writes ``plugin-data/hermes-tern/panes/<TERN_PANE>.json`` (``{session_id, cwd, updated_at, pid}``,
frontend/src/session/pane.ts) each time it adopts a session, and removes it when the user quits.

When ``hermes tern`` starts again in that pane with no session flag (``-r``, ``-c`` or ``--new``),
and the file's process is dead, the launcher resumes that conversation
(``launcher.py``, its root id: the gateway follows it to its compression tip). It does not when:

- the shell runs in another folder than the pane's launch folder or the session's own;
- the session is gone from ``state.db``;
- another launcher claimed it a moment ago (``panes/claims/<root>.json``, written under a lock, so
  two panes restarting together never both take it).

Whether another live pane shows the conversation is known only to the gateway (``viewers.py``), so
the frontend asks it (``viewer.shown``) before it resumes, and starts a new session if one does.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Iterator, Mapping, Optional

from . import plugin_data, processes, sessions

logger = logging.getLogger(__name__)

# Tells the frontend its first session is the pane's, resumed after a restart (its notice).
RESTORED_ENV = "HERMES_TERN_RESTORED"
# The folder `hermes tern` started in, before a resume moves to the session's: the pane file records it.
LAUNCH_CWD_ENV = "HERMES_TERN_LAUNCH_CWD"
# Pane files and claims of dead processes older than this are removed.
STALE_S = 30 * 24 * 3600


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


def _prune(folder: Path, now: float) -> None:
    """Removes pane files and claims whose process died long ago: a pane's id is never reused."""
    for path in [*folder.glob("*.json"), *folder.glob("claims/*.json")]:
        data = _read(path) or {}
        with contextlib.suppress(OSError, TypeError, ValueError):
            if not processes.running(data.get("pid")) and now - float(data.get("updated_at") or path.stat().st_mtime) > STALE_S:
                path.unlink()


def _restorable(pane: str, folder: Path, cwd: str) -> Optional[str]:
    """The root id of the conversation pane ``pane`` showed when its program died, if this launch may take it."""
    record = _read(folder / f"{pane}.json")
    if not record or not isinstance(record.get("session_id"), str) or not record["session_id"]:
        return None
    if processes.running(record.get("pid")):
        return None  # the pane's program still runs (a `hermes tern` inside it)
    sid = record["session_id"]
    session = sessions.row(sid)
    if not session:
        return None
    if _real(cwd) not in {_real(record.get("cwd")), _real(session.get("cwd"))}:
        return None
    lineage = sessions.lineage(sid)
    root = lineage[0] if lineage else sid
    claim = _read(folder / "claims" / f"{root}.json")
    if claim and claim.get("pid") != os.getpid() and processes.running(claim.get("pid")):
        return None
    return root


def plan(*, fresh: bool = False, explicit: bool = False, env: Optional[Mapping[str, str]] = None,
         cwd: Optional[str] = None) -> Optional[str]:
    """The root id of the conversation this pane resumes, or None.

    ``fresh`` (``--new``) forgets the pane's conversation. ``explicit``: the launch names its session
    itself (``-r``, ``-c``), so the pane's own does not apply."""
    env = os.environ if env is None else env
    cwd = os.getcwd() if cwd is None else cwd
    pane = (env.get("TERN_PANE") or "").strip()
    if not pane or not pane.isdigit():
        return None
    try:
        folder = plugin_data.folder("panes")
        (folder / "claims").mkdir(exist_ok=True)
        with _locked(folder):
            if fresh:
                (folder / f"{pane}.json").unlink(missing_ok=True)
                return None
            if explicit:
                return None
            root = _restorable(pane, folder, cwd)
            if root:
                _write(folder / "claims" / f"{root}.json", {"pid": os.getpid(), "pane": pane, "updated_at": time.time()})
            _prune(folder, time.time())
    except Exception:  # noqa: BLE001 - a broken pane file must never stop the launch
        logger.debug("hermes-tern: no pane restore for %s", pane, exc_info=True)
        return None
    return root
