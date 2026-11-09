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
    sys.modules["tern_pkg.pull_requests"].enterprise_hosts = lambda: []
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
                     {"HERMES_TERN_LAUNCH_CWD": str(tmp_path), "HERMES_TERN_RESTORED": "root",
                      "HERMES_TERN_GITHUB_ENTERPRISE_HOSTS": ""})]


def test_exit_75_retries_ink_once_with_identical_flags_and_pane_scope(tern, monkeypatch, tmp_path):
    """Only TSP's reserved exit retries; a dead pane's resume belongs to both launches."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HERMES_TERN", "1")
    monkeypatch.setattr(tern.panes, "plan",
                        lambda flags: (["--resume", "root", *flags], "root"))
    calls = []

    def chat(flags, tui_dir, env=None):
        calls.append((list(flags), tui_dir, dict(env or {})))
        return 75 if len(calls) == 1 else 0

    monkeypatch.setattr(tern, "_chat", chat)
    with pytest.raises(SystemExit) as done:
        tern._run(argparse.Namespace(tui_args=["--", "-m", "example"], worktree=False))
    assert done.value.code == 0
    assert [c[0] for c in calls] == [
        ["--resume", "root", "-m", "example"],
        ["--resume", "root", "-m", "example"],
    ]
    assert calls[0][1] == str(tern.FRONTEND)
    assert calls[1][1] is None
    expected_scope = {
        tern.panes.LAUNCH_CWD_ENV: str(tmp_path),
        tern.panes.RESTORED_ENV: "root",
        "HERMES_TERN_GITHUB_ENTERPRISE_HOSTS": "",
    }
    assert calls[0][2] == expected_scope
    assert calls[1][2] == expected_scope


@pytest.mark.parametrize("exit_code", [1, 2, 17, 42, 130])
def test_non_75_errors_never_trigger_an_ink_retry(tern, monkeypatch, exit_code):
    monkeypatch.delenv("HERMES_TERN", raising=False)
    monkeypatch.delenv("TERN_PANE", raising=False)
    calls = []
    monkeypatch.setattr(tern, "_chat",
                        lambda flags, tui_dir, env=None: calls.append(tui_dir) or exit_code)
    with pytest.raises(SystemExit) as done:
        tern._run(argparse.Namespace(tui_args=["-c"], worktree=False))
    assert done.value.code == exit_code
    assert calls == [str(tern.FRONTEND)]


@pytest.mark.parametrize("opt_out", ["0", "false", "off", "no", "FALSE"])
def test_forced_ordinary_tui_skips_the_tsp_entry(tern, monkeypatch, opt_out):
    monkeypatch.setenv("HERMES_TERN", opt_out)
    monkeypatch.delenv("TERN_PANE", raising=False)
    calls = []
    monkeypatch.setattr(tern, "_chat",
                        lambda flags, tui_dir, env=None: calls.append((flags, tui_dir, env)) or 0)
    with pytest.raises(SystemExit) as done:
        tern._run(argparse.Namespace(tui_args=["--", "--resume", "chosen"], worktree=False))
    assert done.value.code == 0
    assert len(calls) == 1
    assert calls[0][0] == ["--resume", "chosen"]
    assert calls[0][1] is None
    assert calls[0][2][tern.panes.LAUNCH_CWD_ENV] == str(Path.cwd())


def test_in_process_chat_restores_argv_and_frontend_env_after_early_exit(tern, monkeypatch):
    """The next run must not inherit a stale frontend directory or command argv."""
    import os

    old_argv = sys.argv
    monkeypatch.delenv("HERMES_TERN_RESTORED", raising=False)
    monkeypatch.setenv("HERMES_TUI_DIR", "/old/frontend")
    fake = types.ModuleType("hermes_cli.main")

    def main():
        assert sys.argv[1:] == ["chat", "--tui", "-m", "example"]
        assert os.environ["HERMES_TUI_DIR"] == "/new/frontend"
        assert os.environ["HERMES_TERN_RESTORED"] == "root"
        raise SystemExit(75)

    fake.main = main
    monkeypatch.setitem(sys.modules, "hermes_cli.main", fake)
    assert tern._chat(["-m", "example"], "/new/frontend",
                      {"HERMES_TERN_RESTORED": "root"}) == 75
    assert sys.argv is old_argv
    assert os.environ["HERMES_TUI_DIR"] == "/old/frontend"
    assert "HERMES_TERN_RESTORED" not in os.environ

@pytest.mark.parametrize("existing", [None, "old-restored"])
def test_in_process_chat_restores_argv_and_all_scope_after_unexpected_exception(
    tern, monkeypatch, existing,
):
    """Even errors other than SystemExit must not poison the next launch."""
    import os

    saved_argv = sys.argv
    monkeypatch.setenv("HERMES_TUI_DIR", "/old/frontend")
    monkeypatch.setenv("HERMES_TERN_LAUNCH_CWD", "/old/cwd")
    if existing is None:
        monkeypatch.delenv("HERMES_TERN_RESTORED", raising=False)
    else:
        monkeypatch.setenv("HERMES_TERN_RESTORED", existing)
    fake = types.ModuleType("hermes_cli.main")

    def main():
        assert sys.argv[1:] == ["chat", "--tui", "--pass-session-id"]
        assert os.environ["HERMES_TUI_DIR"] == "/new/frontend"
        assert os.environ["HERMES_TERN_RESTORED"] == "fixture-root"
        assert os.environ["HERMES_TERN_LAUNCH_CWD"] == "/new/cwd"
        raise RuntimeError("unexpected launcher failure")

    fake.main = main
    monkeypatch.setitem(sys.modules, "hermes_cli.main", fake)
    with pytest.raises(RuntimeError, match="unexpected launcher failure"):
        tern._chat(
            ["--pass-session-id"], "/new/frontend",
            {"HERMES_TERN_RESTORED": "fixture-root",
             "HERMES_TERN_LAUNCH_CWD": "/new/cwd"},
        )
    assert sys.argv is saved_argv
    assert os.environ["HERMES_TUI_DIR"] == "/old/frontend"
    assert os.environ["HERMES_TERN_LAUNCH_CWD"] == "/old/cwd"
    assert os.environ.get("HERMES_TERN_RESTORED") == existing


def test_the_frontend_learns_the_listed_enterprise_hosts(tern, monkeypatch):
    # The frontend sends the enterprise token only to these; an empty list clears an inherited value.
    monkeypatch.setattr(tern.pull_requests, "enterprise_hosts", lambda: ["ghe.corp.example", "git.corp.example:8443"])
    seen = []
    monkeypatch.setattr(tern, "_chat", lambda flags, tui_dir, env=None: seen.append(env) or 0)
    with pytest.raises(SystemExit):
        tern._run(argparse.Namespace(tui_args=[], worktree=False))
    assert seen[0]["HERMES_TERN_GITHUB_ENTERPRISE_HOSTS"] == "ghe.corp.example,git.corp.example:8443"
