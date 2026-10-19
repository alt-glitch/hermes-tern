"""tern_open.py without Hermes or Tern: tools.registry is stubbed and `tern` is a script that logs its
calls (argv and TERN_PANE) and answers `ls --json` with one more block after a split."""

import importlib.util
import json
import os
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

FAKE = """#!/bin/sh
printf '%s\\t%s\\n' "$TERN_PANE" "$*" >> "$LOG"
case "$1" in
  ls) if grep -q '	split\\|	new' "$LOG"; then echo '{"sessions":[{"tabs":[{"blocks":[{"id":7},{"id":9}]}]}]}';
      else echo '{"sessions":[{"tabs":[{"blocks":[{"id":7}]}]}]}'; fi ;;
  browser) echo '{"ok":{"block":11}}' ;;
  fail) echo 'no such block' >&2; exit 1 ;;
esac
"""


@pytest.fixture()
def tern(tmp_path, monkeypatch):
    registry = types.ModuleType("tools.registry")
    registry.tool_error = lambda message, **extra: json.dumps({"error": message, **extra})
    registry.tool_result = lambda data=None, **kw: json.dumps(data if data is not None else kw)
    approval = types.ModuleType("tools.approval")
    approval.check_all_command_guards = lambda command, env: (
        {"approved": False, "message": "BLOCKED: user denied"} if "rm -rf" in command else {"approved": True})
    monkeypatch.setitem(sys.modules, "tools", types.ModuleType("tools"))
    monkeypatch.setitem(sys.modules, "tools.registry", registry)
    monkeypatch.setitem(sys.modules, "tools.approval", approval)

    spec = importlib.util.spec_from_file_location("tern_open_mod", ROOT / "tern_open.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    cli = tmp_path / "tern"
    cli.write_text(FAKE)
    cli.chmod(0o755)
    log = tmp_path / "calls.log"
    log.touch()
    monkeypatch.setenv("LOG", str(log))
    (tmp_path / "work").mkdir()
    (tmp_path / "work" / "model.glb").write_bytes(b"glTF")
    panes = {"s1": {"TERN_PANE": "7", "TERN_WINDOW_KEY": "3"}}
    monkeypatch.setattr(module, "_find_cli", lambda: str(cli))
    monkeypatch.setattr(module, "_viewer", lambda sid: panes.get(sid, {}))
    monkeypatch.setattr(module, "_session", lambda sid: sid or "")
    monkeypatch.setattr(module, "_cwd", lambda: str(tmp_path / "work"))
    module.calls = lambda: [line.split("\t") for line in log.read_text().splitlines()]
    module.work = tmp_path / "work"
    return module


def run(tern, session="s1", **args):
    return json.loads(tern.tern_open(args, session_id=session))


def test_a_file_opens_beside_the_chat_pane(tern):
    out = run(tern, path="model.glb")
    assert out == {"opened": "file", "path": str((tern.work / "model.glb").resolve()), "place": "right"}
    assert tern.calls() == [["7", f"open --split right {(tern.work / 'model.glb').resolve()}"]]

    run(tern, path="model.glb", place="tab")
    assert tern.calls()[-1][1].startswith("open --tab ")


def test_a_terminal_splits_the_chat_pane_and_runs_its_command(tern):
    out = run(tern, terminal=True, command="ls -la", place="down")
    assert out["block"] == 9 and out["command"] == "ls -la"
    assert [c[1] for c in tern.calls()] == [
        "ls --json", f"split 7 down --cwd {tern.work.resolve()}", "ls --json", "run 9 ls -la"]
    assert {c[0] for c in tern.calls()} == {"7"}


def test_a_command_the_approval_refuses_opens_nothing(tern):
    out = run(tern, terminal=True, command="rm -rf /")
    assert out["error"] == "Not opened: BLOCKED: user denied"
    assert tern.calls() == []


def test_a_url_opens_a_browser_over_the_chat(tern):
    out = run(tern, url="https://stencil.so")
    assert out["answer"] == {"ok": {"block": 11}}
    assert json.loads(tern.calls()[0][1].removeprefix("browser ")) == {"op": "open", "owner": "7", "url": "https://stencil.so"}
    assert "error" in run(tern, url="file:///etc/passwd")


def test_bad_arguments_and_no_pane_say_why(tern):
    assert "exactly one" in run(tern)["error"]
    assert "exactly one" in run(tern, path="model.glb", terminal=True)["error"]
    assert "terminal: true" in run(tern, path="model.glb", command="ls")["error"]
    assert "place" in run(tern, path="model.glb", place="left")["error"]
    assert "does not exist" in run(tern, path="nope.stl")["error"]
    assert "not open in a hermes tern pane" in run(tern, session="elsewhere", path="model.glb")["error"]
    assert tern.calls() == []


def test_the_prompt_is_only_for_a_session_a_tern_pane_shows(tern):
    assert "tern_open" in tern.prompt({"session_id": "s1"})
    assert tern.prompt({"session_id": "telegram"}) == ""


def test_the_viewer_marker_names_the_pane(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("hermes_tern_pkg.tern_open", ROOT / "tern_open.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    viewers = tmp_path / "viewers"
    viewers.mkdir()
    (viewers / "root.json").write_text(json.dumps({"pid": os.getpid(), "tern": {"TERN_PANE": "5", "TERN_PANE_SOCKET": "/s", "HOME": "/x"}}))
    (viewers / "dead.json").write_text(json.dumps({"pid": 2 ** 22 + 1, "tern": {"TERN_PANE": "6"}}))
    (viewers / "plain.json").write_text(json.dumps({"pid": os.getpid()}))
    connections = types.SimpleNamespace(
        _dir=lambda name: viewers, _alive=lambda pid: pid == os.getpid(),
        _lineage=lambda sid: {"tip": ["root", "tip"]}.get(sid, [sid]))
    prs = types.SimpleNamespace(_delegator=lambda sid: {"child": "tip"}.get(sid, sid))
    pkg = types.ModuleType("hermes_tern_pkg")
    pkg.connections, pkg.pull_requests = connections, prs
    monkeypatch.setitem(sys.modules, "hermes_tern_pkg", pkg)

    assert module._viewer("tip") == {"TERN_PANE": "5", "TERN_PANE_SOCKET": "/s"}
    assert module._viewer("child") == {"TERN_PANE": "5", "TERN_PANE_SOCKET": "/s"}
    assert module._viewer("dead") == {}
    assert module._viewer("plain") == {}
