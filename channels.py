"""Frontend channels: which Tern frontend a ``hermes tern`` launch draws, without touching the profile.

A channel is a pinned plugin checkout with a built ``frontend/dist/entry.js``, listed in a registry
shared by every profile (``<hermes root>/tern-channels/channels.json``)::

    {"version": 1,
     "channels": {"main": {"dir": "/abs/checkout", "alias": "mytern", "repo": "...", "ref": "main",
                           "sha": "...", "bundle_sha256": "..."}}}

Only ``dir`` is required. ``alias`` names a top-level command (``hermes --tui mytern``). The
installed plugin's own Python handlers stay loaded in the gateway; a channel changes only the
frontend, and frontends check the gateway's plugin methods before using them.

A pane switches channel live with ``hermes tern switch NAME``: it writes
``panes/<TERN_PANE>.switch.json`` (channel + the session the pane shows), stops that pane's
frontend, and the pane's launcher, seeing the request when its frontend exits, starts the
channel's frontend on the same session. The gateway parks a detached session, so a running turn
keeps going through the swap.
"""

from __future__ import annotations

import contextlib
import json
import os
import signal
import sys
import time
from pathlib import Path
from typing import Any, Mapping, Optional

ENV = "HERMES_TERN_CHANNELS"
# A switch request older than this is ignored (its frontend did not exit when asked).
SWITCH_TTL_S = 60.0


def current_pane(env: Optional[Mapping[str, str]] = None) -> str:
    """The Tern pane this process runs in (Tern sets ``TERN_PANE`` in every pane's shell), or ''."""
    env = os.environ if env is None else env
    return (env.get("TERN_PANE") or "").strip()


def registry_path(env: Optional[Mapping[str, str]] = None) -> Path:
    env = os.environ if env is None else env
    if env.get(ENV):
        return Path(env[ENV]).expanduser()
    try:
        from hermes_constants import get_default_hermes_root
    except ImportError:  # Hermes before the shared-root helper: profiles live under ~/.hermes
        return Path.home() / ".hermes" / "tern-channels" / "channels.json"
    root = get_default_hermes_root()
    return Path(root) / "tern-channels" / "channels.json"


def load(path: Optional[Path] = None) -> dict[str, dict[str, Any]]:
    with contextlib.suppress(OSError, ValueError):
        registry = json.loads((path or registry_path()).read_text())
        chans = registry.get("channels") if isinstance(registry, dict) else None
        if isinstance(chans, dict):
            return {k: v for k, v in chans.items() if isinstance(v, dict) and isinstance(v.get("dir"), str)}
    return {}


def frontend_dir(name: str, path: Optional[Path] = None) -> Path:
    """The channel's ``frontend`` folder (``HERMES_TUI_DIR``); SystemExit naming the problem otherwise."""
    chans = load(path)
    if name not in chans:
        known = ", ".join(sorted(chans)) or "none"
        raise SystemExit(f"hermes tern: no channel {name!r} (channels: {known}; registry {path or registry_path()})")
    front = Path(chans[name]["dir"]).expanduser() / "frontend"
    if not (front / "dist" / "entry.js").is_file():
        raise SystemExit(f"hermes tern: channel {name!r} has no {front / 'dist' / 'entry.js'}")
    return front


def aliases(path: Optional[Path] = None) -> dict[str, str]:
    """alias -> channel, for aliases that are plain command names."""
    out = {}
    for name, chan in load(path).items():
        alias = chan.get("alias")
        if isinstance(alias, str) and alias.replace("-", "").isalnum() and alias != "tern":
            out[alias] = name
    return out


def take_channel(flags: list[str]) -> tuple[list[str], Optional[str]]:
    """Removes ``--channel NAME`` / ``--channel=NAME`` (``hermes chat`` does not know it)."""
    out, chan, i = [], None, 0
    while i < len(flags):
        f = flags[i]
        if f == "--channel" and i + 1 < len(flags):
            chan, i = flags[i + 1], i + 2
            continue
        if f.startswith("--channel="):
            chan = f.split("=", 1)[1]
        else:
            out.append(f)
        i += 1
    return out, chan


def _panes() -> Path:
    from . import connections

    return connections._dir("panes")


def _switch_file(pane: str, folder: Optional[Path] = None) -> Path:
    return (folder or _panes()) / f"{pane}.switch.json"


def _pane_of(pid: int) -> Optional[str]:
    with contextlib.suppress(OSError):
        for item in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0"):
            if item.startswith(b"TERN_PANE="):
                return item.split(b"=", 1)[1].decode()
    return None


def request_switch(name: str, pane: str, folder: Optional[Path] = None, *, kill=os.kill) -> dict[str, Any]:
    """Asks ``pane``'s running ``hermes tern`` to relaunch on channel ``name`` with the same session."""
    frontend_dir(name)  # fail before stopping anything
    folder = folder or _panes()
    try:
        record = json.loads((folder / f"{pane}.json").read_text())
        pid, sid = int(record["pid"]), str(record["session_id"])
    except (OSError, ValueError, KeyError, TypeError):
        raise SystemExit(f"hermes tern: pane {pane} shows no hermes tern conversation") from None
    if _pane_of(pid) != pane:
        raise SystemExit(f"hermes tern: pane {pane}'s frontend (pid {pid}) is not running")
    request = {"channel": name, "session_id": sid, "pid": pid, "at": time.time()}
    staging = _switch_file(pane, folder).with_suffix(".tmp")
    staging.write_text(json.dumps(request))
    os.replace(staging, _switch_file(pane, folder))
    kill(pid, signal.SIGTERM)
    return request


def pending_switch(env: Optional[Mapping[str, str]] = None, folder: Optional[Path] = None) -> Optional[dict[str, Any]]:
    """The switch request for this launcher's pane, consumed; None when there is none (or it is stale)."""
    pane = current_pane(env)
    if not pane.isdigit():
        return None
    path = _switch_file(pane, folder)
    try:
        request = json.loads(path.read_text())
    except FileNotFoundError:
        return None  # the ordinary case: the user quit
    except (OSError, ValueError) as exc:
        print(f"hermes tern: ignoring unreadable switch request {path}: {exc}", file=sys.stderr)
        path.unlink(missing_ok=True)
        return None
    path.unlink(missing_ok=True)
    if not isinstance(request, dict) or time.time() - float(request.get("at") or 0) > SWITCH_TTL_S:
        return None
    if not request.get("channel") or not request.get("session_id"):
        return None
    return request


def default_channel(path: Optional[Path] = None) -> Optional[str]:
    """The registry's ``default`` channel (plain ``hermes tern``), when it names a listed channel."""
    with contextlib.suppress(OSError, ValueError, AttributeError):
        name = json.loads((path or registry_path()).read_text()).get("default")
        if isinstance(name, str) and name in load(path):
            return name
    return None
