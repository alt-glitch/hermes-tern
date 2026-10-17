"""``manage_connections`` for sessions a ``hermes tern`` pane shows.

On the shared gateway nothing answers ``connection.request``, so the tool takes its no-card path
(``tools/connectors/managed.py`` ``_no_card_result``): it returns at once with every app's
``connect_url`` and tells the model to show the links. Nothing then watches the authorizations.

For a session a ``hermes tern`` pane shows (it registers itself under
``plugin-data/hermes-tern/viewers/``), a ``transform_tool_result`` hook:

- keeps the links out of the model's context and tells it the user has a card instead;
- writes the apps, their links and their states to ``plugin-data/hermes-tern/connections/<call id>.json``,
  where the pane draws them;
- starts a watcher thread that reads the connector list every few seconds and writes each app's
  state, until every app is connected or 15 minutes pass. The pane tells the agent when all are.

Every other surface keeps the tool's own result.
"""

from __future__ import annotations

import contextlib
import contextvars
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

PLUGIN = "hermes-tern"
TOOL = "manage_connections"
POLL_SECONDS = 4.0
WATCH_SECONDS = 15 * 60

NOTE = (
    "The user sees these apps on a connect card in hermes tern, each with an Authorize button that "
    "opens its link. Do not repeat, paraphrase or ask for the links. hermes tern tells you when the "
    "user has authorized every app; if they say they are done first, check with action 'status'. "
    "Do not call connect again for the same app."
)

_watching: set[str] = set()
_lock = threading.Lock()


def _dir(name: str) -> Path:
    from plugins.plugin_storage import plugin_data_dir

    path = plugin_data_dir(PLUGIN) / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def viewed_by_tern(session_id: str) -> bool:
    """A live ``hermes tern`` pane shows ``session_id``: its marker names a running process."""
    if not session_id:
        return False
    try:
        marker = json.loads((_dir("viewers") / f"{session_id}.json").read_text())
        os.kill(int(marker["pid"]), 0)
        return True
    except (OSError, ValueError, KeyError, TypeError):
        return False


def _write(call_id: str, data: dict[str, Any]) -> None:
    path = _dir("connections") / f"{call_id}.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data))
    os.replace(tmp, path)


def _status(rows: list[dict[str, Any]], targets: list[dict[str, Any]], baseline: dict[str, bool]) -> bool:
    """Folds the connector list onto ``targets``; True once none waits. An app connected before the
    call (a reconnect) counts only once its status moves."""
    by_name = {str(r.get("connector", "")).lower(): r for r in rows}
    for t in targets:
        if t.get("state") not in ("initiated", "pending"):
            continue
        row = by_name.get(str(t.get("name", "")).lower())
        if not row:
            continue
        status = row.get("connectionStatus") or row.get("connection_status")
        if row.get("connected") and not baseline.get(t["name"]):
            t["state"] = "connected"
        elif status in ("failed", "expired"):
            t["state"] = status
    return not any(t.get("state") in ("initiated", "pending") for t in targets)


def _watch(call_id: str, targets: list[dict[str, Any]], started: float) -> None:
    from tools.connectors.managed import managed_client

    baseline: dict[str, bool] = {}
    try:
        client = managed_client()
        first = client.list_connectors()
        connected = {str(r.get("connector", "")).lower(): bool(r.get("connected")) for r in first}
        baseline = {t["name"]: connected.get(str(t["name"]).lower(), False) for t in targets}
        while time.time() - started < WATCH_SECONDS:
            done = _status(client.list_connectors(), targets, baseline)
            _write(call_id, {"targets": targets, "updated_at": time.time(), "watching": not done})
            if done:
                return
            time.sleep(POLL_SECONDS)
        _write(call_id, {"targets": targets, "updated_at": time.time(), "watching": False})
    except Exception as exc:  # health: allow BLE001 -- a watcher must never take the gateway down
        logger.warning("hermes-tern: connection watcher for %s stopped: %s", call_id, exc)
        with contextlib.suppress(Exception):
            _write(call_id, {"targets": targets, "updated_at": time.time(), "watching": False, "error": str(exc)})
    finally:
        with _lock:
            _watching.discard(call_id)


def transform_tool_result(tool_name: str = "", args: Any = None, result: Any = None, session_id: str = "",
                          tool_call_id: str = "", **_kw: Any) -> Any:
    """The hook: rewrite a no-card connect result for a tern-viewed session, and watch it."""
    if tool_name != TOOL or not isinstance(result, str) or not tool_call_id or not viewed_by_tern(session_id):
        return None
    try:
        payload = json.loads(result)
    except ValueError:
        return None
    targets = payload.get("targets") if isinstance(payload, dict) else None
    if not isinstance(targets, list) or not any(isinstance(t, dict) and t.get("connect_url") for t in targets):
        return None

    card = [dict(t) for t in targets if isinstance(t, dict) and t.get("name")]
    _write(tool_call_id, {"targets": card, "updated_at": time.time(), "watching": True})
    with _lock:
        start = tool_call_id not in _watching
        _watching.add(tool_call_id)
    if start:
        # The hook runs in the tool's thread, inside the session's context (profile, identity): the
        # watcher keeps that context so its client reads the same account.
        ctx = contextvars.copy_context()
        threading.Thread(target=ctx.run, args=(_watch, tool_call_id, card, time.time()),
                         name=f"hermes-tern-connect-{tool_call_id}", daemon=True).start()

    for t in payload["targets"]:
        if isinstance(t, dict):
            t.pop("connect_url", None)
    payload["note"] = NOTE
    return json.dumps(payload, ensure_ascii=False)


def register(ctx) -> None:
    ctx.register_hook("transform_tool_result", transform_tool_result)
