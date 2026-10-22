"""``manage_connections`` for sessions a ``hermes tern`` pane shows, on a gateway that draws no card.

The shared gateway now draws the card itself (hermes-agent 204d6abdb6, ``gateway/local_desktop_ui.py``
``wire``): every turn a local viewer runs gets ``agent.connection_callback``, so the tool opens an
operation, sends the pane ``connection.request`` and ``connection.update``, and waits for the card's
answer (``connection.respond``). The pane answers it (``frontend/src/connections/live.ts``); that
result carries no ``connect_url``, so this hook leaves it alone. The hook only serves an older
gateway, where nothing answers ``connection.request``.

There the tool takes its no-card path (``tools/connectors/managed.py`` ``_no_card_result``): it
returns at once with every app's ``connect_url`` and tells the model to show the links. Nothing
then watches the authorizations.

For a session a ``hermes tern`` pane shows (it registers itself under
``plugin-data/hermes-tern/viewers/``, by the conversation's id; compression gives the agent a new
one, so the whole compression lineage counts), a ``transform_tool_result`` hook:

- keeps the links out of the model's context and tells it the user has a card instead;
- writes the apps, their links and their states to
  ``plugin-data/hermes-tern/connections/<call id>.<op id>.json``, where the pane draws them. The
  card is named by the result's ``op_id`` as well, as the desktop names its card: models reuse call
  ids (``call_0`` on every turn), so the call id alone can point at an earlier call's card;
- retires the rows of this conversation's older cards that the new call asks for again (a
  reconnect, the same account asked twice), so only the newest card waits on an app;
- starts a watcher thread that reads the user's accounts every few seconds and writes each app's
  state, until every app is resolved or 15 minutes pass. The pane tells the agent when all are.

The card file is backend-owned, as the desktop's operation is: the watcher alone moves a row, and
``settled_by`` says why it stopped (``all_resolved``, ``continued``, ``deadline``, ``superseded``, ``error``).

Every other surface keeps the tool's own result.
"""

from __future__ import annotations

import contextlib
import contextvars
import json
import logging
import os
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

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

WAITING = ("initiated", "pending")

# An account row's status -> the state it ends the attempt in (core's managed._ACCOUNT_OUTCOME);
# `pending` is the attempt still running and moves nothing.
_OUTCOME = {"active": "connected", "failed": "failed", "revoked": "failed", "inactive": "failed", "expired": "expired"}
# The key ``_status`` keeps once a read listed the accounts.
_ACCOUNTS = "accounts"


class _Card:
    """One card and its watcher, in this process: the hook that supersedes its rows and the thread
    that moves them write the file under ``_lock``, so neither overwrites the other's change."""

    def __init__(self, op_id: str, call_id: str, session: str, targets: list[dict[str, Any]]):
        self.op_id, self.call_id, self.session, self.targets = op_id, call_id, session, targets
        self.created_at = time.time()
        self.settled_by: Optional[str] = None
        self.error: Optional[str] = None

    @property
    def stem(self) -> str:
        return f"{_safe(self.call_id)}.{_safe(self.op_id)}"

    def data(self) -> dict[str, Any]:
        out = {"op_id": self.op_id, "call_id": self.call_id, "session": self.session, "pid": os.getpid(),
               "created_at": self.created_at, "updated_at": time.time(), "targets": self.targets,
               "watching": self.settled_by is None, "settled_by": self.settled_by}
        if self.error:
            out["error"] = self.error
        return out

    def settle(self, by: str) -> None:
        """The first reason wins; an app still waiting is no longer watched, so it did not connect."""
        if self.settled_by is not None:
            return
        self.settled_by = by
        for t in self.targets:
            if t.get("state") in WAITING:
                t["state"] = "not_connected"


_cards: dict[str, _Card] = {}
_lock = threading.Lock()


def _safe(part: str) -> str:
    # The pane builds the same name (frontend/src/connections.ts `cardStem`).
    return re.sub(r"[^A-Za-z0-9_-]", "_", part)


def _dir(name: str) -> Path:
    from plugins.plugin_storage import plugin_data_dir

    path = plugin_data_dir(PLUGIN) / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def _lineage(session_id: str) -> list[str]:
    """The conversation's session ids, root first: compression gives a conversation a new id, and the
    pane names the conversation by its root (``stored_session_id``)."""
    if not session_id:
        return []
    with contextlib.suppress(Exception):
        from hermes_state import SessionDB

        ids = SessionDB(read_only=True).get_compression_lineage(session_id)
        if ids:
            return [str(i) for i in ids]
    return [session_id]


def _alive(pid: Any) -> bool:
    """Whether process ``pid`` runs. On Windows ``os.kill(pid, 0)`` would end it, so it asks the OS instead."""
    try:
        pid = int(pid)
    except (ValueError, TypeError):
        return False
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True  # it runs, as another user
    except OSError:
        return False


def viewed_by_tern(session_id: str) -> bool:
    """A live ``hermes tern`` pane shows ``session_id``'s conversation: a marker under any id of its
    compression lineage names a running process."""
    viewers = _dir("viewers")
    for sid in reversed(_lineage(session_id)):
        try:
            if _alive(json.loads((viewers / f"{sid}.json").read_text())["pid"]):
                return True
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return False


def _write(card: _Card) -> None:
    path = _dir("connections") / f"{card.stem}.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(card.data()))
    os.replace(tmp, path)


def _account(t: dict[str, Any]) -> tuple[str, str]:
    return str(t.get("name", "")).lower(), str(t.get("alias") or "")


def _supersede(card: _Card) -> None:
    """Retire this conversation's older rows for the accounts ``card`` waits on (call under ``_lock``),
    as the desktop's newer operation replaces the card: one live card per account. A card left with
    nothing to wait on settles as ``superseded``."""
    asked = {_account(t) for t in card.targets if t.get("state") in WAITING}
    for old in _cards.values():
        if old is card or old.session != card.session or old.settled_by is not None:
            continue
        moved = False
        for t in old.targets:
            if t.get("state") in WAITING and _account(t) in asked:
                t["state"], moved = "superseded", True
        if not moved:
            continue
        if not any(t.get("state") in WAITING for t in old.targets):
            old.settled_by = "superseded"
        with contextlib.suppress(Exception):
            _write(old)


def _signature(rows: list[dict[str, Any]], accounts: Optional[list[dict[str, Any]]]) -> dict[str, str]:
    """What each account (``acct:<id>``) and each connector (``conn:<slug>``) looks like now."""
    seen: dict[str, str] = {}
    for a in accounts or []:
        if a.get("connectionId") and not a.get("disabled"):
            seen[f"acct:{a['connectionId']}"] = str(a.get("status") or "").lower()
    for r in rows:
        status = str(r.get("connectionStatus") or r.get("connection_status") or "").lower()
        seen[f"conn:{str(r.get('connector', '')).lower()}"] = "active" if r.get("connected") and status in ("", "active") else status
    return seen


def _status(rows: list[dict[str, Any]], accounts: Optional[list[dict[str, Any]]], targets: list[dict[str, Any]],
            last: dict[str, str]) -> bool:
    """Folds one read onto ``targets``; True once none waits. A row moves only on a change since the
    last read (``last``, the first read being the baseline), so an app that was connected before the
    call (a reconnect, a second account) counts once its new attempt ends, not at once and not never.

    With the account list, the target's accounts are read, as core's watcher reads the minted account
    (``managed._status_for``): an account that is new or newly active connected it. The connector-wide
    flag counts as well, and alone when the accounts cannot be listed."""
    now = _signature(rows, accounts)
    # Accounts count only against an account baseline: without one, every existing account would
    # look new.
    by_account = accounts is not None and _ACCOUNTS in last
    if accounts is not None:
        now[_ACCOUNTS] = "read"
    for t in targets:
        if t.get("state") not in WAITING:
            continue
        name, alias = _account(t)
        if by_account:
            mine = [a for a in accounts if str(a.get("connector", "")).lower() == name and not a.get("disabled")]
            if alias:
                mine = [a for a in mine if alias in (a.get("alias"), a.get("label"))] or mine
            keys = [f"acct:{a['connectionId']}" for a in mine if a.get("connectionId")]
        else:
            keys = []
        # The connector-wide flag moves too when the first account of an app connects.
        keys.append(f"conn:{name}")
        moved = [now[k] for k in keys if k in now and now[k] != last.get(k)]
        if "active" in moved:
            t["state"] = "connected"
        elif (ended := next((_OUTCOME[s] for s in moved if s in _OUTCOME), None)) is not None:
            t["state"] = ended
    last.update(now)
    return not any(t.get("state") in WAITING for t in targets)


def _accounts() -> Optional[list[dict[str, Any]]]:
    """The user's accounts; None when this Portal cannot list them (the connector list stands in)."""
    try:
        from tools.connectors.managed import portal_accounts

        return portal_accounts()
    except Exception as exc:  # health: allow BLE001 -- an optional read; the connector list still answers
        logger.debug("hermes-tern: account list unavailable: %s", exc)
        return None


def _watch(card: _Card) -> None:
    from tools.connectors.managed import managed_client

    try:
        client = managed_client()
        last: dict[str, str] = {}
        # The baseline: what the accounts looked like once the call minted its links.
        _status(client.list_connectors(), _accounts(), [], last)
        while time.time() - card.created_at < WATCH_SECONDS:
            time.sleep(POLL_SECONDS)
            rows, accounts = client.list_connectors(), _accounts()
            with _lock:
                if card.settled_by is not None:
                    return
                if _status(rows, accounts, card.targets, last):
                    card.settle("all_resolved")
                elif (_dir("connections") / f"{card.stem}.told").exists():
                    # The user pressed Continue: the desktop settles the op there, and so does this card.
                    card.settle("continued")
                _write(card)
            if card.settled_by is not None:
                return
        with _lock:
            card.settle("deadline")
            _write(card)
    except Exception as exc:  # health: allow BLE001 -- a watcher must never take the gateway down
        logger.warning("hermes-tern: connection watcher for %s stopped: %s", card.op_id, exc)
        with _lock, contextlib.suppress(Exception):
            card.error = str(exc)
            card.settle("error")
            _write(card)
    finally:
        with _lock:
            _cards.pop(card.op_id, None)


def transform_tool_result(tool_name: str = "", args: Any = None, result: Any = None, session_id: str = "",
                          tool_call_id: str = "", **_kw: Any) -> Any:
    """The hook: rewrite a no-card connect result for a tern-viewed session, and watch it. A result
    with no ``connect_url`` (a status read, or the card path's settled result) passes unchanged."""
    if tool_name != TOOL or not isinstance(result, str) or not tool_call_id or not viewed_by_tern(session_id):
        return None
    try:
        payload = json.loads(result)
    except ValueError:
        return None
    targets = payload.get("targets") if isinstance(payload, dict) else None
    if not isinstance(targets, list) or not any(isinstance(t, dict) and t.get("connect_url") for t in targets):
        return None

    # The no-card result carries its operation's id; the pane names the card by it.
    op_id = str(payload.get("op_id") or uuid.uuid4().hex[:12])
    payload["op_id"] = op_id
    session = (_lineage(session_id) or [session_id])[0]
    card = _Card(op_id, tool_call_id, session, [dict(t) for t in targets if isinstance(t, dict) and t.get("name")])
    with _lock:
        start = op_id not in _cards
        if start:
            _cards[op_id] = card
            _supersede(card)
            _write(card)
    if start:
        # The hook runs in the tool's thread, inside the session's context (profile, identity): the
        # watcher keeps that context so its client reads the same account.
        ctx = contextvars.copy_context()
        threading.Thread(target=ctx.run, args=(_watch, card), name=f"hermes-tern-connect-{op_id}", daemon=True).start()

    for t in payload["targets"]:
        if isinstance(t, dict):
            t.pop("connect_url", None)
    payload["note"] = NOTE
    return json.dumps(payload, ensure_ascii=False)


def register(ctx) -> None:
    ctx.register_hook("transform_tool_result", transform_tool_result)
