"""`hermes tern`'s own launcher: its flags, the frontend's environment, and the NO_TSP fallback."""

import argparse
import json
import sys
import types

import pytest

from hermes_tern_plugin import launcher


def parse(argv, **top):
    """Parses `hermes [top] tern ARGV` as Hermes' parser would: the top-level values first, then tern's."""
    parser = argparse.ArgumentParser()
    launcher.setup(parser)
    return parser.parse_args(argv, namespace=argparse.Namespace(**top))


@pytest.fixture()
def launched(monkeypatch, tmp_path):
    """Runs the launcher; the frontend's exit code is `code`. Returns each command run and its env."""
    (tmp_path / "dist").mkdir()
    (tmp_path / "dist" / "entry.js").write_text("")
    monkeypatch.setattr(launcher, "FRONTEND", tmp_path)
    monkeypatch.setattr(launcher, "node_binary", lambda: "/bin/node")
    monkeypatch.setattr(launcher, "hermes_command", lambda: {"argv": ["/py", "-m", "hermes_cli.main"], "env": {"PYTHONPATH": "/src"}})
    monkeypatch.setattr(launcher, "_local_terminal", lambda: True)
    monkeypatch.setattr(launcher, "client_env", lambda: {"PATH": "/bin"})
    monkeypatch.setattr(launcher, "_session_cwd", lambda sid: None)
    monkeypatch.setattr(launcher.pull_requests, "enterprise_hosts", lambda: [])
    monkeypatch.delenv("TERN_PANE", raising=False)
    constants = types.ModuleType("hermes_constants")
    constants.get_hermes_home = lambda: tmp_path / "home"
    monkeypatch.setitem(sys.modules, "hermes_constants", constants)
    monkeypatch.chdir(tmp_path)

    def go(args, code=0):
        runs = []

        def call(argv, env=None, **_):
            runs.append((argv, env))
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


def test_the_flags_map_back_to_hermes_chat():
    args = parse(["-m", "x", "-s", "a,b", "-s", "b", "--yolo", "--max-turns", "5", "-Q", "--new"])
    assert launcher.chat_flags(args) == ["--model=x", "--skills=a,b", "--max-turns=5", "--yolo", "--quiet", "--new"]


def test_the_launch_policy_rides_session_create():
    args = parse(["-m", "x", "--provider", "p", "-t", "web, file", "-s", "a", "--max-turns", "5", "--yolo", "--ignore-rules"])
    options = launcher.create_options(args)
    assert {k: v for k, v in options.items() if k != "client_env"} == {
        "model": "x", "provider": "p", "toolsets": ["web", "file"], "skills": ["a"], "max_turns": 5,
        "yolo": True, "ignore_rules": True}


def test_client_env_keeps_toolchain_names_and_leaves_secrets_out(monkeypatch):
    monkeypatch.setitem(sys.modules, "hermes_cli.config", types.SimpleNamespace(load_config=lambda: {}))
    env = launcher.client_env({"PATH": "/bin", "VIRTUAL_ENV": "/v", "NODE_OPTIONS": "-x", "NODE_AUTH_TOKEN": "t",
                               "OPENAI_API_KEY": "k", "HERMES_HOME": "/h", "HERMES_INFERENCE_PROVIDER": "p", "LANG": "C"})
    assert env == {"PATH": "/bin", "VIRTUAL_ENV": "/v", "NODE_OPTIONS": "-x", "HERMES_INFERENCE_PROVIDER": "p"}


def test_the_frontend_gets_its_own_variables(launched, monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_TERN_RESUME", "stale")
    code, [(argv, env)] = launched(parse(["-q", "hi", "-m", "x", "-v"]))
    assert code == 0
    assert argv == ["/bin/node", "--expose-gc", str(tmp_path / "dist" / "entry.js")]
    assert "HERMES_TERN_RESUME" not in env
    assert env["HERMES_TERN_QUERY"] == "hi" and env["HERMES_TERN_TOOL_PROGRESS"] == "verbose"
    assert json.loads(env["HERMES_TERN_CREATE"]) == {"model": "x", "client_env": {"PATH": "/bin"}}
    assert json.loads(env["HERMES_TERN_HERMES"])["argv"] == ["/py", "-m", "hermes_cli.main"]
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
    monkeypatch.setattr(launcher.panes, "plan", lambda flags: (["--resume", "root", *flags], "root"))
    _, [(_, env)] = launched(parse(["-m", "x"]))
    assert env["HERMES_TERN_RESUME"] == env["HERMES_TERN_RESTORED"] == "root"


def test_worktree_is_refused_until_hermes_has_a_public_api(launched):
    assert launched(parse(["-w"]))[0] == 2
    assert launched(parse([], worktree=True))[0] == 2


def test_no_tsp_runs_the_regular_tui_as_a_process(launched, tmp_path):
    code, runs = launched(parse(["-m", "x", "-q", "hi"]), code=launcher.NO_TSP_EXIT)
    assert code == 0
    argv, env = runs[1]
    assert argv == ["/py", "-m", "hermes_cli.main", "chat", "--tui", "--model=x", "--query=hi"]
    assert env["PYTHONPATH"] == "/src" and env["HERMES_HOME"] == str(tmp_path / "home")
    assert "HERMES_TERN_QUERY" not in env


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
