"""viewers.py: the plugin RPC methods a pane calls to say which session it shows."""

import os
import types

import pytest

from hermes_tern_plugin import processes, sessions, viewers

LINEAGE = {"live": ["stored", "live"]}


@pytest.fixture(autouse=True)
def world(monkeypatch):
    monkeypatch.setattr(processes, "running", lambda pid: pid == os.getpid())
    monkeypatch.setattr(sessions, "lineage", lambda sid: LINEAGE.get(sid, [sid]))
    monkeypatch.setattr(viewers, "_viewers", {})


def test_set_keeps_the_claim_under_the_session_and_its_stored_id_of_the_same_conversation():
    assert viewers.set_viewer({"pid": os.getpid(), "stored": "stored", "tern": {"TERN_PANE": "1"}},
                              session_id="live") == {"ids": ["live", "stored"]}
    assert viewers.viewer_of(["stored"]).tern == {"TERN_PANE": "1"}
    # A stored id of another conversation is not taken.
    assert viewers.set_viewer({"pid": os.getpid(), "stored": "other"}, session_id="live") == {"ids": ["live"]}


def test_only_tern_variables_are_kept():
    viewers.set_viewer({"pid": os.getpid(), "tern": {"TERN_PANE": "1", "PATH": "/evil", "TERN_WINDOW_KEY": 3}},
                       session_id="a")
    assert viewers.viewer_of(["a"]).tern == {"TERN_PANE": "1"}


def test_clear_drops_only_its_own_claim():
    viewers.set_viewer({"pid": os.getpid(), "tern": {"TERN_PANE": "1"}}, session_id="a")
    viewers.clear_viewer({"pid": 4242}, session_id="a")
    assert viewers.viewer_of(["a"]) is not None
    viewers.clear_viewer({"pid": os.getpid()}, session_id="a")
    assert viewers.viewer_of(["a"]) is None


def test_shown_reads_live_panes_across_the_lineage():
    assert viewers.shown({"ids": ["live"]}) == {"shown": False}
    viewers.set_viewer({"pid": os.getpid()}, session_id="stored")
    assert viewers.shown({"ids": ["live"]}) == {"shown": True}


@pytest.mark.parametrize("call, params, session_id", [
    (viewers.set_viewer, {"pid": os.getpid()}, None),
    (viewers.set_viewer, {"pid": True}, "a"),
    (viewers.set_viewer, {"pid": -3}, "a"),
    (viewers.clear_viewer, {"pid": os.getpid()}, None),
    (viewers.shown, {"ids": []}, None),
])
def test_bad_params_fail_the_call(call, params, session_id):
    with pytest.raises(ValueError):
        call(params, session_id=session_id)


def test_register_serves_three_methods():
    names = []
    viewers.register(types.SimpleNamespace(register_rpc=lambda name, fn: names.append(name)))
    assert names == ["viewer.set", "viewer.clear", "viewer.shown"]
