"""Frontend channels and the live in-pane switch: same profile and session, another frontend."""

import argparse
import json
import os
import signal
import subprocess
import sys
import time

import pytest

import hermes_tern_plugin as tern
from hermes_tern_plugin import channels


@pytest.fixture(autouse=True)
def plugin_data(tmp_path, monkeypatch):
    def _dir(name):
        path = tmp_path / "plugin-data" / name
        path.mkdir(parents=True, exist_ok=True)
        return path

    monkeypatch.setattr(tern.connections, "_dir", _dir)


def checkout(tmp_path, name):
    d = tmp_path / "checkouts" / name
    (d / "frontend" / "dist").mkdir(parents=True)
    (d / "frontend" / "dist" / "entry.js").write_text("// " + name)
    return d


@pytest.fixture()
def registry(tmp_path):
    reg = channels.registry_path()
    reg.parent.mkdir(parents=True)
    data = {"version": 1, "default": "upstream", "channels": {
        "upstream": {"dir": str(checkout(tmp_path, "upstream"))},
        "main": {"dir": str(checkout(tmp_path, "main")), "alias": "mytern"},
        "preview": {"dir": str(checkout(tmp_path, "preview")), "alias": "myternp"},
    }}
    reg.write_text(json.dumps(data))
    return data


def test_aliases_and_default_come_from_the_registry(registry):
    assert channels.aliases() == {"mytern": "main", "myternp": "preview"}
    assert channels.default_channel() == "upstream"


def test_channel_flag_is_taken_out_of_the_chat_flags():
    assert channels.take_channel(["-c", "--channel", "main", "-m", "x"]) == (["-c", "-m", "x"], "main")
    assert channels.take_channel(["--channel=preview"]) == ([], "preview")
    assert channels.take_channel(["-c"]) == (["-c"], None)


def test_unknown_channel_fails_naming_the_known_ones(registry):
    with pytest.raises(SystemExit, match="main, preview, upstream"):
        channels.frontend_dir("nope")


def run(monkeypatch, argv, channel=None, codes=(0,)):
    calls, codes = [], list(codes)
    monkeypatch.delenv("TERN_PANE", raising=False)

    def chat(flags, tui_dir, env=None):
        calls.append((list(flags), tui_dir))
        return codes.pop(0) if codes else 0

    monkeypatch.setattr(tern, "_chat", chat)
    with pytest.raises(SystemExit):
        tern._run(argparse.Namespace(tui_args=argv, worktree=False), channel)
    return calls


def test_plain_tern_uses_the_default_channel_and_aliases_their_own(registry, monkeypatch):
    up, main = registry["channels"]["upstream"]["dir"], registry["channels"]["main"]["dir"]
    assert run(monkeypatch, ["-c"]) == [(["-c"], os.path.join(up, "frontend"))]
    assert run(monkeypatch, ["-c"], channel="main") == [(["-c"], os.path.join(main, "frontend"))]
    assert run(monkeypatch, ["--channel", "main"]) == [([], os.path.join(main, "frontend"))]


def test_without_a_registry_tern_draws_its_own_frontend(monkeypatch):
    assert run(monkeypatch, ["-c"]) == [(["-c"], str(tern.FRONTEND))]


def test_a_switch_request_relaunches_the_same_session_on_the_new_channel(registry, monkeypatch):
    folder = tern.connections._dir("panes")
    calls = []

    def chat(flags, tui_dir, env=None):
        calls.append((list(flags), tui_dir))
        if len(calls) == 1:  # `hermes tern switch preview` ran while this frontend drew
            (folder / "77.switch.json").write_text(json.dumps(
                {"channel": "preview", "session_id": "local-abc", "pid": 1, "at": time.time()}))
            return -signal.SIGTERM
        return 0

    monkeypatch.setenv("TERN_PANE", "77")
    monkeypatch.setattr(tern.panes, "plan", lambda flags: (flags, None))
    monkeypatch.setattr(tern, "_chat", chat)
    with pytest.raises(SystemExit) as done:
        tern._run(argparse.Namespace(tui_args=["-r", "old", "-m", "x"], worktree=False))
    assert done.value.code == 0
    preview = os.path.join(registry["channels"]["preview"]["dir"], "frontend")
    assert calls[1] == (["--resume", "local-abc", "-m", "x"], preview)
    assert not (folder / "77.switch.json").exists()


def test_a_stale_switch_request_is_ignored(registry, monkeypatch):
    folder = tern.connections._dir("panes")
    (folder / "5.switch.json").write_text(json.dumps(
        {"channel": "main", "session_id": "s", "at": time.time() - 3600}))
    assert channels.pending_switch({"TERN_PANE": "5"}) is None


def test_request_switch_stops_only_that_panes_frontend(registry, tmp_path):
    folder = tern.connections._dir("panes")
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"],
                            env={**os.environ, "TERN_PANE": "42"})
    try:
        (folder / "42.json").write_text(json.dumps({"pid": proc.pid, "session_id": "local-xyz"}))
        killed = []
        req = channels.request_switch("main", "42", kill=lambda pid, sig: killed.append((pid, sig)))
        assert killed == [(proc.pid, signal.SIGTERM)]
        assert req["session_id"] == "local-xyz"
        assert channels.pending_switch({"TERN_PANE": "42"})["channel"] == "main"
        # A pid that is not that pane's frontend is never signalled.
        (folder / "43.json").write_text(json.dumps({"pid": proc.pid, "session_id": "local-xyz"}))
        with pytest.raises(SystemExit, match="not running"):
            channels.request_switch("main", "43", kill=lambda *a: pytest.fail("signalled"))
    finally:
        proc.kill()
