"""`hermes tern` hands every flag to `hermes chat --tui`, the top-level ones too."""

import argparse
import importlib.util
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture()
def tern(monkeypatch):
    # The package's Python halves are not under test here.
    for name in ("connections", "pull_requests"):
        monkeypatch.setitem(sys.modules, f"tern_pkg.{name}", types.ModuleType(name))
    spec = importlib.util.spec_from_file_location("tern_pkg", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "tern_pkg", module)
    spec.loader.exec_module(module)
    return module


def flags_of(tern, monkeypatch, **args):
    seen = []
    monkeypatch.delenv("TERN_PANE", raising=False)  # outside a Tern pane: nothing to resume
    monkeypatch.setattr(tern, "_chat", lambda flags, tui_dir, env=None: seen.append(flags) or 0)
    with pytest.raises(SystemExit):
        tern._run(argparse.Namespace(**args))
    return seen[0]


def test_a_top_level_worktree_flag_reaches_the_tui_launcher(tern, monkeypatch):
    # `hermes -w tern -m x`: argparse puts -w on the namespace, the rest in tui_args.
    assert flags_of(tern, monkeypatch, tui_args=["-m", "x"], worktree=True) == ["--worktree", "-m", "x"]


def test_a_worktree_flag_after_tern_is_not_doubled(tern, monkeypatch):
    assert flags_of(tern, monkeypatch, tui_args=["-w"], worktree=True) == ["-w"]
    assert flags_of(tern, monkeypatch, tui_args=["-m", "x"], worktree=False) == ["-m", "x"]


def test_a_restored_pane_tells_the_frontend(tern, monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(tern.panes, "plan", lambda flags: (["--resume", "root", *flags], "root"))
    seen = []
    monkeypatch.setattr(tern, "_chat", lambda flags, tui_dir, env=None: seen.append((flags, env)) or 0)
    with pytest.raises(SystemExit):
        tern._run(argparse.Namespace(tui_args=["-m", "x"], worktree=False))
    assert seen == [(["--resume", "root", "-m", "x"],
                     {"HERMES_TERN_LAUNCH_CWD": str(tmp_path), "HERMES_TERN_RESTORED": "root"})]
