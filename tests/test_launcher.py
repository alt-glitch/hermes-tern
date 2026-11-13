"""`hermes tern`'s own launcher: its flags, the frontend's environment, and a terminal that is not Tern."""

import argparse
import json
import os
import sys
import types
from pathlib import Path

import pytest

from hermes_tern_plugin import launcher


def parse(argv, **top):
    """Parses `hermes [top] tern ARGV` as Hermes' parser would: the top-level values first, then tern's."""
    parser = argparse.ArgumentParser()
    launcher.setup(parser)
    return parser.parse_args(argv, namespace=argparse.Namespace(**top))


@pytest.fixture()
def hermes(monkeypatch, tmp_path):
    """Hermes' published launcher functions, faked in `sys.modules`. `calls` records each call in order."""
    fake = types.SimpleNamespace(calls=[], tree={"path": str(tmp_path / "tree"), "branch": "hermes/x",
                                                 "repo_root": str(tmp_path), "base": "main"})
    (tmp_path / "tree").mkdir()
    chat_launch = types.ModuleType("hermes_cli.chat_launch")
    chat_launch.hermes_command = lambda args=(): ["/hermes", *args]
    chat_launch.print_exit_summary = lambda sid, *, command: fake.calls.append(("summary", sid, command))
    gateway_chat = types.ModuleType("hermes_cli.gateway_chat")
    gateway_chat.shell_client_env = lambda: {"PATH": "/bin", "NODE_SESSION_AFFINITY": "lab"}
    worktree = types.ModuleType("hermes_cli.session_worktree")
    worktree.create = lambda: fake.calls.append(("create", os.getcwd())) or fake.tree
    worktree.restore = lambda sid: fake.calls.append(("restore", sid))
    worktree.finish = lambda info, sid, *, ask: fake.calls.append(("finish", info["path"], sid, ask))
    package = types.ModuleType("hermes_cli")
    package.__path__ = []
    package.session_worktree = worktree
    for name, module in (("hermes_cli", package), ("hermes_cli.chat_launch", chat_launch),
                         ("hermes_cli.gateway_chat", gateway_chat), ("hermes_cli.session_worktree", worktree)):
        monkeypatch.setitem(sys.modules, name, module)
    return fake


@pytest.fixture()
def launched(monkeypatch, tmp_path, hermes):
    """Runs the launcher; the frontend's exit code is `code`, and it shows session `shows` (written to
    the launcher's session file). Returns the exit code and each command run with its env."""
    (tmp_path / "dist").mkdir()
    (tmp_path / "dist" / "entry.js").write_text("")
    monkeypatch.setattr(launcher, "FRONTEND", tmp_path)
    monkeypatch.setattr(launcher, "node_binary", lambda: "/bin/node")
    monkeypatch.setattr(launcher, "_local_terminal", lambda: True)
    monkeypatch.setattr(launcher, "_session_cwd", lambda sid: None)
    monkeypatch.setattr(launcher.pull_requests, "enterprise_hosts", lambda: [])
    monkeypatch.delenv("TERN_PANE", raising=False)
    constants = types.ModuleType("hermes_constants")
    constants.get_hermes_home = lambda: tmp_path / "home"
    monkeypatch.setitem(sys.modules, "hermes_constants", constants)
    monkeypatch.chdir(tmp_path)

    def go(args, code=0, shows=None):
        runs = []

        def call(argv, env=None, **_):
            runs.append((argv, env))
            hermes.calls.append(("frontend", os.getcwd()))
            if shows:
                Path(env["HERMES_TERN_SESSION_FILE"]).write_text(json.dumps({"session_id": shows}))
            return code if len(runs) == 1 else 0

        monkeypatch.setattr(launcher.subprocess, "call", call)
        with pytest.raises(SystemExit) as done:
            launcher.run(args)
        return done.value.code, runs

    return go


def test_tern_flags_and_hermes_top_level_flags_both_count():
    args = parse(["-q", "hi", "--image", "a.png"], model="top-model", yolo=True, worktree=False)
    assert args.model == "top-model" and args.yolo and args.query == "hi"
    # A tern flag left out does not reset the top-level value.
    assert not hasattr(parse([]), "model")


def test_the_launch_policy_rides_session_create():
    args = parse(["-m", "x", "--provider", "p", "-t", "web, file", "-s", "a", "--max-turns", "5", "--yolo", "--ignore-rules"])
    assert launcher.create_options(args, {}) == {
        "model": "x", "provider": "p", "toolsets": ["web", "file"], "skills": ["a"], "max_turns": 5,
        "yolo": True, "ignore_rules": True}


def test_the_frontend_gets_its_own_variables(launched, monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_TERN_RESUME", "stale")
    code, [(argv, env)] = launched(parse(["-q", "hi", "-m", "x", "-v"]))
    assert code == 0
    assert argv == ["/bin/node", "--expose-gc", str(tmp_path / "dist" / "entry.js")]
    assert "HERMES_TERN_RESUME" not in env
    assert env["HERMES_TERN_QUERY"] == "hi" and env["HERMES_TERN_TOOL_PROGRESS"] == "verbose"
    # Hermes' shell_client_env() and hermes_command(), unchanged.
    assert json.loads(env["HERMES_TERN_CREATE"]) == {"model": "x", "client_env": {"PATH": "/bin", "NODE_SESSION_AFFINITY": "lab"}}
    assert json.loads(env["HERMES_TERN_HERMES"]) == ["/hermes"]
    assert env["HERMES_TERN_CWD"] == env["HERMES_TERN_SESSION_CWD"] == env["HERMES_TERN_LAUNCH_CWD"] == str(tmp_path)
    assert env["HERMES_HOME"] == str(tmp_path / "home")
    assert "--max-old-space-size=8192" in env["NODE_OPTIONS"]


def test_the_frontend_learns_the_listed_enterprise_hosts(launched, monkeypatch):
    # The frontend sends the enterprise token only to these. A value inherited from the shell never counts.
    monkeypatch.setenv("HERMES_TERN_GITHUB_ENTERPRISE_HOSTS", "github.evil.example")
    _, [(_, env)] = launched(parse([]))
    assert env["HERMES_TERN_GITHUB_ENTERPRISE_HOSTS"] == ""
    monkeypatch.setattr(launcher.pull_requests, "enterprise_hosts", lambda: ["ghe.corp.example", "git.corp.example:8443"])
    _, [(_, env)] = launched(parse([]))
    assert env["HERMES_TERN_GITHUB_ENTERPRISE_HOSTS"] == "ghe.corp.example,git.corp.example:8443"


def test_resume_and_continue_pick_the_session(launched, monkeypatch):
    monkeypatch.setattr(launcher, "resolve_session", lambda name: {"my chat": "tip-1"}.get(name))
    monkeypatch.setattr(launcher, "latest_session", lambda: "last-1")
    assert launched(parse(["-r", "my chat"]))[1][0][1]["HERMES_TERN_RESUME"] == "tip-1"
    # An id nothing knows is kept: the frontend says the session is not found.
    assert launched(parse(["-r", "nope"]))[1][0][1]["HERMES_TERN_RESUME"] == "nope"
    assert launched(parse(["-c"]))[1][0][1]["HERMES_TERN_RESUME"] == "last-1"
    assert launched(parse(["-c", "nope"]))[0] == 1


def test_a_restored_pane_tells_the_frontend(launched, monkeypatch):
    asked = []
    monkeypatch.setattr(launcher.panes, "plan", lambda **how: asked.append(how) or "root")
    _, [(_, env)] = launched(parse(["-m", "x"]))
    assert env["HERMES_TERN_RESUME"] == env["HERMES_TERN_RESTORED"] == "root"
    assert asked == [{"fresh": False, "explicit": False}]


def test_a_session_flag_or_new_keeps_the_pane_from_resuming_its_own(launched, monkeypatch):
    asked = []
    monkeypatch.setattr(launcher.panes, "plan", lambda **how: asked.append(how))
    monkeypatch.setattr(launcher, "resolve_session", lambda name: "tip-1")
    launched(parse(["-r", "my chat"]))
    launched(parse(["--new"]))
    assert asked == [{"fresh": False, "explicit": True}, {"fresh": True, "explicit": False}]


def test_an_older_hermes_gets_one_line_and_exit_1(launched, monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "hermes_cli.chat_launch", None)  # its import raises ImportError
    code, runs = launched(parse([]))
    assert code == 1 and runs == []
    assert capsys.readouterr().err == launcher.TOO_OLD + "\n"


@pytest.mark.parametrize("code, quit", [(0, True), (130, True), (1, False), (launcher.NO_TSP_EXIT, False)])
def test_the_summary_names_the_session_the_pane_ended_on_after_a_quit_only(launched, hermes, code, quit):
    launched(parse([]), code=code, shows="s-last")
    summaries = [c for c in hermes.calls if c[0] == "summary"]
    assert summaries == ([("summary", "s-last", "hermes tern")] if quit else [])


def test_the_session_file_is_removed_after_the_frontend_exits(launched):
    _, [(_, env)] = launched(parse([]), shows="s-1")
    assert not Path(env["HERMES_TERN_SESSION_FILE"]).exists()


def test_a_quit_without_a_session_prints_no_summary(launched, hermes):
    launched(parse([]))
    assert not [c for c in hermes.calls if c[0] == "summary"]


@pytest.mark.parametrize("code, ask", [(0, True), (130, True), (1, False)])
def test_worktree_is_made_before_the_frontend_and_finished_after_it(launched, hermes, tmp_path, code, ask):
    _, [(_, env)] = launched(parse(["-w"]), code=code, shows="s-1")
    tree = str(tmp_path / "tree")
    assert [c[0] for c in hermes.calls if c[0] != "summary"] == ["create", "frontend", "finish"]
    assert hermes.calls[0] == ("create", str(tmp_path))  # made from the launch folder
    assert hermes.calls[1] == ("frontend", os.path.realpath(tree))  # the frontend runs in the tree
    assert env["HERMES_TERN_SESSION_CWD"] == os.path.realpath(tree)
    assert hermes.calls[-1] == ("finish", tree, "s-1", ask)


def test_no_worktree_is_made_when_node_is_missing(launched, hermes, monkeypatch):
    monkeypatch.setattr(launcher, "node_binary", lambda: None)
    code, runs = launched(parse(["-w"]))
    assert code == 1 and runs == []
    assert not [c for c in hermes.calls if c[0] == "create"]


def test_worktree_is_finished_when_the_frontend_cannot_start(launched, hermes, monkeypatch, tmp_path):
    def call(argv, env=None, **_):
        raise OSError("exec format error")

    monkeypatch.setattr(launcher.subprocess, "call", call)
    with pytest.raises(OSError):
        launcher.run(parse(["-w"]))
    assert hermes.calls[-1] == ("finish", str(tmp_path / "tree"), None, False)


def test_worktree_that_cannot_be_made_stops_the_launch(launched, hermes):
    hermes.tree = None
    code, runs = launched(parse(["-w"]))
    assert code == 1 and runs == []


def test_a_resume_restores_its_worktree_unless_w_is_set(launched, hermes, monkeypatch):
    monkeypatch.setattr(launcher, "resolve_session", lambda name: "tip-1")
    launched(parse(["-r", "my chat"]))
    assert ("restore", "tip-1") in hermes.calls
    hermes.calls.clear()
    launched(parse(["-r", "my chat", "-w"]))
    assert not [c for c in hermes.calls if c[0] == "restore"]


def test_a_terminal_that_is_not_tern_gets_one_line_and_no_other_program(launched, capsys):
    code, runs = launched(parse(["-m", "x", "-q", "hi"]), code=launcher.NO_TSP_EXIT)
    assert code == 1
    assert len(runs) == 1  # the frontend only: nothing runs in its place
    assert "not a Tern pane" in capsys.readouterr().err


def test_resume_takes_the_short_id_the_quit_summary_prints(monkeypatch):
    full = "local-" + "a" * 64

    class Db:
        def resolve_session_id(self, prefix):
            return full if full.startswith(prefix) else None

        def resolve_session_by_title(self, title):
            return None

        def get_compression_tip(self, sid):
            return None

        def close(self):
            pass

    monkeypatch.setitem(sys.modules, "hermes_state", types.SimpleNamespace(SessionDB=lambda read_only: Db()))
    assert launcher.resolve_session(full[:22]) == full
    assert launcher.resolve_session("other") is None


def test_continue_finds_a_frontend_session_on_the_shared_gateway(monkeypatch, tmp_path):
    # The shared gateway stores a frontend's session as source `local`, created by `tui`.
    asked = []

    class Db:
        def search_sessions(self, **kwargs):
            asked.append(kwargs)
            return [{"id": "s-tui"}] if kwargs.get("local_created_sources") == ["tui"] and "workspace_key" in kwargs else []

        def close(self):
            pass

    monkeypatch.setitem(sys.modules, "hermes_state", types.SimpleNamespace(SessionDB=lambda read_only: Db()))
    monkeypatch.setattr(launcher, "_workspace", lambda: str(tmp_path))
    assert launcher.latest_session() == "s-tui"
    assert asked == [{"limit": 1, "skip_launch_stubs": True, "source": ["tui", "local"],
                      "local_created_sources": ["tui"], "workspace_key": str(tmp_path)}]


def test_continue_looks_in_this_workspace_for_either_kind_of_session_before_anywhere(monkeypatch, tmp_path):
    asked = []

    class Db:
        def search_sessions(self, **kwargs):
            asked.append(("ws" if "workspace_key" in kwargs else "any", kwargs["local_created_sources"][0]))
            return [{"id": "cli-here"}] if asked[-1] == ("ws", "cli") else [{"id": "tui-elsewhere"}] if asked[-1][0] == "any" else []

        def close(self):
            pass

    monkeypatch.setitem(sys.modules, "hermes_state", types.SimpleNamespace(SessionDB=lambda read_only: Db()))
    monkeypatch.setattr(launcher, "_workspace", lambda: str(tmp_path))
    assert launcher.latest_session() == "cli-here"
    assert asked == [("ws", "tui"), ("ws", "cli")]


def test_exported_launch_flags_reach_session_create(monkeypatch):
    monkeypatch.setenv("HERMES_YOLO_MODE", "1")
    monkeypatch.setenv("HERMES_ACCEPT_HOOKS", "true")
    monkeypatch.setenv("HERMES_IGNORE_RULES", "0")
    assert launcher.create_options(parse([]), {}) == {"yolo": True, "accept_hooks": True}
