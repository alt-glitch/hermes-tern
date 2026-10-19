"""tern_env.py without Hermes: the session context, the terminal base class and the plugin's
connections/pull_requests helpers are stubbed; markers go to a temp dir."""

import contextvars
import importlib.util
import json
import os
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture()
def tern(tmp_path, monkeypatch):
    unset = object()
    session_id = contextvars.ContextVar("HERMES_SESSION_ID", default=unset)
    context = types.ModuleType("gateway.session_context")
    context._UNSET, context._VAR_MAP = unset, {"HERMES_SESSION_ID": session_id}
    monkeypatch.setitem(sys.modules, "gateway", types.ModuleType("gateway"))
    monkeypatch.setitem(sys.modules, "gateway.session_context", context)

    class BaseEnvironment:
        def _snapshot_excluded_passthrough_names(self):
            return ("GH_TOKEN",)

    base = types.ModuleType("tools.environments.base")
    base.BaseEnvironment = BaseEnvironment
    for name in ("tools", "tools.environments"):
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    monkeypatch.setitem(sys.modules, "tools.environments.base", base)

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

    def marker(sid, pid=os.getpid(), **tern):
        (viewers / f"{sid}.json").write_text(json.dumps({"pid": pid, "tern": tern}))

    module.marker, module.session, module.unset = marker, session_id, unset
    module.var_map, module.Base = context._VAR_MAP, BaseEnvironment
    assert module.install()
    return module


def child_env(tern):
    """What Hermes' ``_inject_session_context_env`` reads for the Tern names."""
    return {name: tern.var_map[name].get() for name in tern.TERN_VARS}


def test_a_child_gets_the_pane_of_the_session_it_runs_for(tern, monkeypatch):
    monkeypatch.setenv("TERN_PANE", "gateway-pane")
    tern.marker("a", TERN_PANE="1", TERN_WINDOW_KEY="3", HOME="/x")
    tern.marker("b", TERN_PANE="2", TERN_PANE_SOCKET="/s")

    tern.session.set("a")
    assert child_env(tern) == {"TERN_PANE": "1", "TERN_PANE_SOCKET": "", "TERN_WINDOW_KEY": "3",
                               "TERN_WINDOW_SOCKET": "", "TERN_DAEMON_SOCKET": ""}
    tern.session.set("b")
    assert child_env(tern)["TERN_PANE"] == "2" and child_env(tern)["TERN_PANE_SOCKET"] == "/s"


def test_a_compressed_conversation_and_its_subagents_keep_the_pane(tern):
    tern.marker("root", TERN_PANE="5")
    for sid in ("tip", "child"):
        tern.session.set(sid)
        assert tern.var_map["TERN_PANE"].get() == "5"


def test_no_live_pane_keeps_the_gateway_own_values(tern, monkeypatch):
    monkeypatch.setenv("TERN_PANE", "gateway-pane")
    monkeypatch.delenv("TERN_WINDOW_KEY", raising=False)
    tern.marker("gone", pid=2 ** 22 + 1, TERN_PANE="9")
    for sid in ("gone", "telegram"):
        tern.session.set(sid)
        assert tern.var_map["TERN_PANE"].get() == "gateway-pane"
        assert tern.var_map["TERN_WINDOW_KEY"].get() is tern.unset
    tern.session.set(tern.unset)
    assert tern.var_map["TERN_PANE"].get() == "gateway-pane"


def test_the_names_stay_out_of_the_shared_shell_snapshot(tern):
    names = tern.Base()._snapshot_excluded_passthrough_names()
    assert "GH_TOKEN" in names and set(tern.TERN_VARS) <= set(names)
    tern.install()
    assert tern.Base()._snapshot_excluded_passthrough_names() == names


def test_resetting_the_session_vars_is_harmless(tern):
    for var in tern.var_map.values():
        var.set(tern.unset)
    tern.marker("a", TERN_PANE="1")
    tern.session.set("a")
    assert tern.var_map["TERN_PANE"].get() == "1"
