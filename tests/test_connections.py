"""connections.py without Hermes: plugin storage, the session store and the connector client are stubbed."""

import importlib.util
import json
import os
import sys
import time
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

RESULT = json.dumps({"op_id": "op1", "status": "initiated", "note": "Show each connect_url to the user", "targets": [
    {"name": "googledrive", "state": "initiated", "connect_url": "https://portal/x"},
    {"name": "gmail", "state": "initiated", "connect_url": "https://portal/y"},
    {"name": "slack", "state": "connected"}]})


def one(name="googledrive", op="op2", **extra):
    return json.dumps({"op_id": op, "status": "initiated",
                       "targets": [{"name": name, "state": "initiated", "connect_url": f"https://p/{op}", **extra}]})


@pytest.fixture()
def conn(tmp_path, monkeypatch):
    storage = types.ModuleType("plugins.plugin_storage")
    storage.plugin_data_dir = lambda name: tmp_path
    monkeypatch.setitem(sys.modules, "plugins", types.ModuleType("plugins"))
    monkeypatch.setitem(sys.modules, "plugins.plugin_storage", storage)

    lists, accounts, lineages = [], [], {}

    def step(seq):
        return seq.pop(0) if len(seq) > 1 else seq[0]

    class Client:
        def list_connectors(self):
            return step(lists)

    def portal_accounts():
        if not accounts:
            raise RuntimeError("this Portal lists no accounts")
        found = step(accounts)
        if found is None:
            raise RuntimeError("account read failed")
        return found

    managed = types.ModuleType("tools.connectors.managed")
    managed.managed_client = lambda: Client()
    managed.portal_accounts = portal_accounts
    for name in ("tools", "tools.connectors"):
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    monkeypatch.setitem(sys.modules, "tools.connectors.managed", managed)

    class SessionDB:
        def __init__(self, read_only=False):
            pass

        def get_compression_lineage(self, sid):
            return lineages.get(sid, [sid])

    state = types.ModuleType("hermes_state")
    state.SessionDB = SessionDB
    monkeypatch.setitem(sys.modules, "hermes_state", state)

    spec = importlib.util.spec_from_file_location("tern_connections", ROOT / "connections.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "POLL_SECONDS", 0.01)
    module.lists, module.accounts, module.lineages = lists, accounts, lineages
    module.root = tmp_path
    return module


def view(conn, sid, pid=None):
    (conn.root / "viewers").mkdir(exist_ok=True)
    (conn.root / "viewers" / f"{sid}.json").write_text(json.dumps({"pid": pid or os.getpid()}))


def card(conn, call_id, op_id):
    return json.loads((conn.root / "connections" / f"{call_id}.{op_id}.json").read_text())


def states(conn, call_id, op_id):
    return [t["state"] for t in card(conn, call_id, op_id)["targets"]]


def wait_for(cond, seconds=3.0):
    end = time.time() + seconds
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.01)
    return False


def hook(conn, result, sid="s1", call="c1"):
    out = conn.transform_tool_result(tool_name="manage_connections", result=result, session_id=sid, tool_call_id=call)
    return json.loads(out) if out else None


def test_other_surfaces_keep_the_tool_result(conn):
    assert hook(conn, RESULT) is None
    view(conn, "s1", pid=999999)  # a dead pane counts for nothing
    assert hook(conn, RESULT) is None
    view(conn, "s1")
    assert conn.transform_tool_result(tool_name="terminal", result=RESULT, session_id="s1", tool_call_id="c1") is None


def test_links_leave_the_model_result_and_the_watcher_sees_apps_connect(conn):
    view(conn, "s1")
    conn.lists.extend([
        [{"connector": "googledrive", "connected": False}, {"connector": "gmail", "connected": False}],
        [{"connector": "googledrive", "connected": True}, {"connector": "gmail", "connected": False}],
        [{"connector": "googledrive", "connected": True}, {"connector": "gmail", "connected": True}],
    ])

    out = hook(conn, RESULT)

    assert not any("connect_url" in t for t in out["targets"])
    assert "Do not repeat" in out["note"]
    # The pane names the card by the operation: call ids repeat across turns.
    assert out["op_id"] == "op1"
    first = card(conn, "c1", "op1")
    assert first["targets"][0]["connect_url"] == "https://portal/x"
    assert first["session"] == "s1" and first["pid"] == os.getpid() and first["watching"]
    assert wait_for(lambda: not card(conn, "c1", "op1")["watching"])
    assert states(conn, "c1", "op1") == ["connected", "connected", "connected"]
    assert card(conn, "c1", "op1")["settled_by"] == "all_resolved"


def test_a_reconnect_waits_for_the_status_to_move(conn):
    view(conn, "s1")
    conn.lists.extend([[{"connector": "googledrive", "connected": True}]])

    hook(conn, one(), call="c2")
    time.sleep(0.1)

    assert states(conn, "c2", "op2") == ["initiated"]


def test_a_reconnect_completes_once_the_connector_status_comes_back(conn):
    # No account list: the connector-wide status stands in.
    view(conn, "s1")
    conn.lists.extend([
        [{"connector": "googledrive", "connected": True, "connectionStatus": "active"}],
        [{"connector": "googledrive", "connected": False, "connectionStatus": "pending"}],
        [{"connector": "googledrive", "connected": True, "connectionStatus": "active"}],
    ])

    hook(conn, one(), call="c2")

    assert wait_for(lambda: states(conn, "c2", "op2") == ["connected"])


def test_an_expired_account_reconnected_is_not_marked_expired_at_once(conn):
    view(conn, "s1")
    conn.lists.extend([[{"connector": "googledrive", "connected": False, "connectionStatus": "expired"}]])

    hook(conn, one(), call="c2")
    time.sleep(0.1)

    assert states(conn, "c2", "op2") == ["initiated"]


def test_a_reconnect_completes_when_the_new_account_turns_active(conn):
    view(conn, "s1")
    connected = [{"connector": "googledrive", "connected": True, "connectionStatus": "active"}]
    old = {"connectionId": "a1", "connector": "googledrive", "status": "active", "label": "me@x"}
    conn.lists.extend([connected])
    conn.accounts.extend([
        [old, {"connectionId": "a2", "connector": "googledrive", "status": "pending", "label": "me@x"}],
        [old, {"connectionId": "a2", "connector": "googledrive", "status": "pending", "label": "me@x"}],
        [dict(old, disabled=True), {"connectionId": "a2", "connector": "googledrive", "status": "active", "label": "me@x"}],
    ])

    hook(conn, one(action="reconnect"), call="c2")

    assert wait_for(lambda: states(conn, "c2", "op2") == ["connected"])


def test_a_second_account_completes_when_it_appears(conn):
    view(conn, "s1")
    personal = {"connectionId": "a1", "connector": "gmail", "status": "active", "alias": "personal", "label": "me@x"}
    conn.lists.extend([[{"connector": "gmail", "connected": True}]])
    conn.accounts.extend([
        [personal],
        [personal],
        [personal, {"connectionId": "a2", "connector": "gmail", "status": "active", "alias": "work", "label": "me@work"}],
    ])

    hook(conn, one("gmail", alias="work"), call="c2")

    assert wait_for(lambda: states(conn, "c2", "op2") == ["connected"])


def test_an_account_list_missing_at_the_start_does_not_count_every_account_as_new(conn):
    view(conn, "s1")
    conn.lists.extend([[{"connector": "gmail", "connected": True}]])
    conn.accounts.extend([None, [{"connectionId": "a1", "connector": "gmail", "status": "active", "label": "me@x"}]])

    hook(conn, one("gmail"), call="c2")
    time.sleep(0.1)

    assert states(conn, "c2", "op2") == ["initiated"]


def test_after_compression_the_marker_under_the_root_still_counts(conn):
    # The pane marks the conversation's root (stored_session_id); the agent runs on the tip.
    view(conn, "root")
    conn.lineages["tip"] = ["root", "mid", "tip"]
    conn.lists.extend([[{"connector": "googledrive", "connected": False}]])

    out = hook(conn, one(), sid="tip", call="c2")

    assert out and "connect_url" not in out["targets"][0]
    assert card(conn, "c2", "op2")["session"] == "root"


def test_a_newer_card_for_the_same_account_retires_the_older_rows(conn):
    view(conn, "s1")
    view(conn, "s2")
    conn.lists.extend([[{"connector": "googledrive", "connected": False}, {"connector": "gmail", "connected": False}]])

    hook(conn, RESULT, call="call_0")
    hook(conn, one("googledrive", op="other"), sid="s2", call="call_0")  # another conversation: untouched
    assert states(conn, "call_0", "op1") == ["initiated", "initiated", "connected"]

    hook(conn, one("googledrive", op="op2"), call="call_0")  # the same call id, a later turn
    older = card(conn, "call_0", "op1")
    assert [t["state"] for t in older["targets"]] == ["superseded", "initiated", "connected"]
    assert older["watching"]

    hook(conn, one("gmail", op="op3"), call="call_1")
    older = card(conn, "call_0", "op1")
    assert [t["state"] for t in older["targets"]] == ["superseded", "superseded", "connected"]
    assert not older["watching"] and older["settled_by"] == "superseded"
    assert states(conn, "call_0", "op2") == ["initiated"]
    # A named account is another account: it supersedes nothing.
    hook(conn, one("gmail", op="op4", alias="work"), call="call_2")
    assert states(conn, "call_1", "op3") == ["initiated"]


def test_the_deadline_settles_what_still_waits(conn, monkeypatch):
    monkeypatch.setattr(conn, "WATCH_SECONDS", 0.05)
    view(conn, "s1")
    conn.lists.extend([[{"connector": "googledrive", "connected": False}]])

    hook(conn, one(), call="c2")

    assert wait_for(lambda: card(conn, "c2", "op2")["settled_by"] == "deadline")
    assert states(conn, "c2", "op2") == ["not_connected"]
    assert not card(conn, "c2", "op2")["watching"]
