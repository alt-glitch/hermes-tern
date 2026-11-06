"""tern_env.py: each session's commands get the Tern variables of the pane that shows it, through
``ctx.register_session_env``. The panes say what they show through viewers.py's RPC handlers."""

import os
import types

import pytest

from hermes_tern_plugin import tern_env, viewers

LINEAGE = {"tip": ["root", "tip"]}
DELEGATOR = {"child": "tip"}


@pytest.fixture(autouse=True)
def world(monkeypatch):
    conn = types.SimpleNamespace(_alive=lambda pid: pid == os.getpid(), _lineage=lambda sid: LINEAGE.get(sid, [sid]))
    monkeypatch.setattr(viewers, "_connections", lambda: conn)
    monkeypatch.setattr(viewers, "_viewers", {})
    monkeypatch.setattr(tern_env, "_ids", {})
    import hermes_tern_plugin.connections as connections
    import hermes_tern_plugin.pull_requests as pull_requests
    monkeypatch.setattr(connections, "_lineage", conn._lineage)
    monkeypatch.setattr(pull_requests, "_delegator", lambda sid: DELEGATOR.get(sid, sid))


def show(session, pid=None, stored=None, **tern):
    viewers.set_viewer({"pid": pid or os.getpid(), "tern": tern, **({"stored": stored} if stored else {})}, session_id=session)


def test_concurrent_sessions_each_get_their_own_pane():
    show("a", TERN_PANE="1", TERN_WINDOW_KEY="w 3", HOME="/x")
    show("b", TERN_PANE="2", TERN_PANE_SOCKET="/s")
    assert tern_env.pane_env("a") == {"TERN_PANE": "1", "TERN_WINDOW_KEY": "w 3", "TERN_PANE_SOCKET": None,
                                      "TERN_WINDOW_SOCKET": None, "TERN_DAEMON_SOCKET": None}
    assert tern_env.pane_env("b")["TERN_PANE"] == "2" and tern_env.pane_env("b")["TERN_PANE_SOCKET"] == "/s"


def test_a_compressed_conversation_and_its_subagents_keep_the_pane():
    show("root", TERN_PANE="5")
    for sid in ("tip", "child"):
        assert tern_env.pane_env(sid)["TERN_PANE"] == "5"


def test_no_live_pane_leaves_the_gateways_own_values():
    assert tern_env.pane_env("a") == {}
    show("a", pid=4242, TERN_PANE="1")  # its process died
    assert tern_env.pane_env("a") == {}
    show("b")  # a pane outside Tern names no pane
    assert tern_env.pane_env("b") == {}


def test_a_conversation_resumed_in_another_pane_follows_it():
    show("a", TERN_PANE="1")
    show("a", pid=os.getppid(), TERN_PANE="2")  # another live process shows it now
    viewers._connections()._alive = lambda pid: pid in (os.getpid(), os.getppid())
    assert tern_env.pane_env("a")["TERN_PANE"] == "2"
    viewers.clear_viewer({"pid": os.getppid()}, session_id="a")
    assert tern_env.pane_env("a")["TERN_PANE"] == "1"


def test_register_uses_the_public_session_env_api():
    calls = []
    tern_env.register(types.SimpleNamespace(register_session_env=lambda names, fn: calls.append((names, fn))))
    assert calls == [(list(tern_env.TERN_VARS), tern_env.pane_env)]
    tern_env.register(types.SimpleNamespace())  # an older Hermes: nothing, nothing raised
