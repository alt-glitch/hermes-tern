"""connections.py without Hermes: plugin storage and the connector client are stubbed."""

import importlib.util
import json
import os
import sys
import time
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

RESULT = json.dumps({"status": "initiated", "note": "Show each connect_url to the user", "targets": [
    {"name": "googledrive", "state": "initiated", "connect_url": "https://portal/x"},
    {"name": "gmail", "state": "initiated", "connect_url": "https://portal/y"},
    {"name": "slack", "state": "connected"}]})


@pytest.fixture()
def conn(tmp_path, monkeypatch):
    storage = types.ModuleType("plugins.plugin_storage")
    storage.plugin_data_dir = lambda name: tmp_path
    monkeypatch.setitem(sys.modules, "plugins", types.ModuleType("plugins"))
    monkeypatch.setitem(sys.modules, "plugins.plugin_storage", storage)

    lists = []

    class Client:
        def list_connectors(self):
            return lists.pop(0) if len(lists) > 1 else lists[0]

    managed = types.ModuleType("tools.connectors.managed")
    managed.managed_client = lambda: Client()
    for name in ("tools", "tools.connectors"):
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    monkeypatch.setitem(sys.modules, "tools.connectors.managed", managed)

    spec = importlib.util.spec_from_file_location("tern_connections", ROOT / "connections.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "POLL_SECONDS", 0.01)
    module.lists = lists
    module.root = tmp_path
    return module


def view(conn, sid, pid=None):
    (conn.root / "viewers").mkdir(exist_ok=True)
    (conn.root / "viewers" / f"{sid}.json").write_text(json.dumps({"pid": pid or os.getpid()}))


def card(conn, call_id):
    return json.loads((conn.root / "connections" / f"{call_id}.json").read_text())


def wait_for(cond, seconds=3.0):
    end = time.time() + seconds
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.01)
    return False


def test_other_surfaces_keep_the_tool_result(conn):
    assert conn.transform_tool_result(tool_name="manage_connections", result=RESULT, session_id="s1", tool_call_id="c1") is None
    view(conn, "s1", pid=999999)  # a dead pane counts for nothing
    assert conn.transform_tool_result(tool_name="manage_connections", result=RESULT, session_id="s1", tool_call_id="c1") is None
    view(conn, "s1")
    assert conn.transform_tool_result(tool_name="terminal", result=RESULT, session_id="s1", tool_call_id="c1") is None


def test_links_leave_the_model_result_and_the_watcher_sees_apps_connect(conn):
    view(conn, "s1")
    conn.lists.extend([
        [{"connector": "googledrive", "connected": False}, {"connector": "gmail", "connected": False}],
        [{"connector": "googledrive", "connected": True}, {"connector": "gmail", "connected": False}],
        [{"connector": "googledrive", "connected": True}, {"connector": "gmail", "connected": True}],
    ])

    out = json.loads(conn.transform_tool_result(tool_name="manage_connections", result=RESULT, session_id="s1", tool_call_id="c1"))

    assert not any("connect_url" in t for t in out["targets"])
    assert "Do not repeat" in out["note"]
    assert card(conn, "c1")["targets"][0]["connect_url"] == "https://portal/x"
    assert wait_for(lambda: not card(conn, "c1")["watching"])
    assert [t["state"] for t in card(conn, "c1")["targets"]] == ["connected", "connected", "connected"]


def test_a_reconnect_waits_for_the_status_to_move(conn):
    view(conn, "s1")
    conn.lists.extend([[{"connector": "googledrive", "connected": True}]])
    one = json.dumps({"status": "initiated", "targets": [{"name": "googledrive", "state": "initiated", "connect_url": "https://p/x"}]})

    conn.transform_tool_result(tool_name="manage_connections", result=one, session_id="s1", tool_call_id="c2")
    time.sleep(0.1)

    assert card(conn, "c2")["targets"][0]["state"] == "initiated"
