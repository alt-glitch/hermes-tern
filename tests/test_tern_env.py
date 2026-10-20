"""tern_env.py without Hermes: the plugin's connections/pull_requests helpers are stubbed and
markers go to a temp dir. The middleware is called as Hermes calls ``tool_request`` middleware."""

import importlib.util
import json
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture()
def tern(tmp_path, monkeypatch):
    viewers = tmp_path / "viewers"
    viewers.mkdir()
    pkg = types.ModuleType("tern_pkg")
    pkg.connections = types.SimpleNamespace(
        _dir=lambda name: viewers, _alive=lambda pid: pid == os.getpid(),
        _lineage=lambda sid: {"tip": ["root", "tip"]}.get(sid, [sid]))
    pkg.pull_requests = types.SimpleNamespace(_delegator=lambda sid: {"child": "tip"}.get(sid, sid))
    monkeypatch.setitem(sys.modules, "tern_pkg", pkg)
    spec = importlib.util.spec_from_file_location("tern_pkg.tern_env", ROOT / "tern_env.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "FRESH_S", 0)
    for name in module.TERN_VARS:
        monkeypatch.delenv(name, raising=False)

    def marker(sid, pid=os.getpid(), **tern):
        (viewers / f"{sid}.json").write_text(json.dumps({"pid": pid, "tern": tern}))

    module.marker = marker
    return module


def run(tern, session, command="echo $TERN_PANE", tool="terminal", **args):
    """The command as Hermes would run it after the middleware."""
    out = tern.tool_request(tool_name=tool, args={"command": command, **args}, original_args={}, session_id=session)
    return out["args"]["command"] if out else command


def shell(command):
    return subprocess.run(["bash", "-c", command], capture_output=True, text=True, env={"PATH": os.environ["PATH"]}).stdout


def test_a_command_runs_with_the_pane_of_its_session(tern):
    tern.marker("a", TERN_PANE="1", TERN_WINDOW_KEY="w 3", HOME="/x")
    tern.marker("b", TERN_PANE="2", TERN_PANE_SOCKET="/s")

    a = run(tern, "a", "env | grep ^TERN_ | sort")
    assert a.startswith(tern.MARK)
    assert shell(a) == "TERN_PANE=1\nTERN_WINDOW_KEY=w 3\n"
    assert shell(run(tern, "b", 'echo "$TERN_PANE $TERN_PANE_SOCKET"')) == "2 /s\n"


def test_background_commands_and_their_other_args_go_through(tern):
    tern.marker("a", TERN_PANE="1")
    out = tern.tool_request(tool_name="terminal", args={"command": "sleep 9", "background": True}, session_id="a")
    assert out["args"]["background"] is True and out["args"]["command"].endswith("; sleep 9")


def test_a_compressed_conversation_and_its_subagents_keep_the_pane(tern):
    tern.marker("root", TERN_PANE="5")
    for sid in ("tip", "child"):
        assert shell(run(tern, sid)) == "5\n"


def test_no_pane_leaves_the_command_alone_and_a_lost_pane_is_taken_back(tern, monkeypatch):
    assert run(tern, "a") == "echo $TERN_PANE"
    tern.marker("a", TERN_PANE="1")
    assert shell(run(tern, "a")) == "1\n"

    # The pane closed: the next command gets the gateway's own values back (here: none) once.
    tern.marker("a", pid=-1, TERN_PANE="1")
    monkeypatch.setenv("TERN_WINDOW_KEY", "gw")
    taken = run(tern, "a", 'echo "[$TERN_PANE] $TERN_WINDOW_KEY"')
    assert shell(f"export TERN_PANE=1; {taken}") == "[] gw\n"
    assert run(tern, "a") == "echo $TERN_PANE"


def test_other_tools_and_odd_args_are_left_alone(tern):
    tern.marker("a", TERN_PANE="1")
    assert tern.tool_request(tool_name="read_file", args={"path": "x"}, session_id="a") is None
    assert tern.tool_request(tool_name="terminal", args={"command": "  "}, session_id="a") is None
    assert tern.tool_request(tool_name="terminal", args=None, session_id="a") is None


def test_register_uses_the_public_middleware_api(tern):
    calls = []
    tern.register(types.SimpleNamespace(register_middleware=lambda kind, fn: calls.append((kind, fn))))
    assert calls == [("tool_request", tern.tool_request)]
