"""`hermes tern`'s own launcher: its flags, the frontend's environment, and a terminal that is not Tern."""

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


def test_worktree_is_refused_until_hermes_has_a_public_api(launched):
    assert launched(parse(["-w"]))[0] == 2
    assert launched(parse([], worktree=True))[0] == 2


def test_a_terminal_that_is_not_tern_gets_one_line_and_no_other_program(launched, capsys):
    code, runs = launched(parse(["-m", "x", "-q", "hi"]), code=launcher.NO_TSP_EXIT)
    assert code == 1
    assert len(runs) == 1  # the frontend only: nothing runs in its place
    assert "not a Tern pane" in capsys.readouterr().err


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
    monkeypatch.setattr(launcher, "client_env", lambda: {})
    monkeypatch.setenv("HERMES_YOLO_MODE", "1")
    monkeypatch.setenv("HERMES_ACCEPT_HOOKS", "true")
    monkeypatch.setenv("HERMES_IGNORE_RULES", "0")
    assert launcher.create_options(parse([])) == {"yolo": True, "accept_hooks": True}


def test_exit_75_keeps_restored_launch_scope_without_an_ink_retry(launched, monkeypatch, tmp_path):
    monkeypatch.setattr(launcher.panes, "plan", lambda **kwargs: "root")
    code, [(_, env)] = launched(parse(["-m", "example"]), code=launcher.NO_TSP_EXIT)
    assert code == 1
    assert env[launcher.panes.LAUNCH_CWD_ENV] == str(tmp_path)
    assert env[launcher.panes.RESTORED_ENV] == env["HERMES_TERN_RESUME"] == "root"
    assert env["HERMES_TERN_GITHUB_ENTERPRISE_HOSTS"] == ""
    assert json.loads(env["HERMES_TERN_CREATE"])["model"] == "example"


@pytest.mark.parametrize("exit_code", [1, 2, 17, 42, 130])
def test_non_75_errors_never_trigger_an_ink_retry(launched, exit_code):
    code, runs = launched(parse(["-m", "example"]), code=exit_code)
    assert code == exit_code
    assert len(runs) == 1


@pytest.mark.parametrize("opt_out", ["0", "false", "off", "no", "FALSE"])
def test_old_ink_opt_out_no_longer_bypasses_the_native_frontend(launched, monkeypatch, opt_out):
    monkeypatch.setenv("HERMES_TERN", opt_out)
    monkeypatch.setattr(launcher, "resolve_session", lambda name: "chosen")
    code, [(argv, env)] = launched(parse(["--resume", "chosen"]))
    assert code == 0
    assert argv[:2] == ["/bin/node", "--expose-gc"]
    assert env["HERMES_TERN_RESUME"] == "chosen"


def test_child_launch_keeps_parent_argv_and_environment_after_early_exit(launched, monkeypatch):
    import os

    monkeypatch.setenv("HERMES_TERN_RESTORED", "outer-root")
    monkeypatch.setenv("HERMES_TERN_LAUNCH_CWD", "/outer/cwd")
    monkeypatch.setenv("HERMES_TUI_DIR", "/outer/frontend")
    saved_argv, saved_env = list(sys.argv), dict(os.environ)
    code, [(_, env)] = launched(parse(["-m", "example"]), code=75)
    assert code == 1
    assert "HERMES_TERN_RESTORED" not in env
    assert json.loads(env["HERMES_TERN_CREATE"])["model"] == "example"
    assert sys.argv == saved_argv and dict(os.environ) == saved_env


@pytest.mark.parametrize("existing", [None, "old-restored"])
def test_child_launch_keeps_parent_scope_after_unexpected_exception(launched, monkeypatch, existing):
    import os

    monkeypatch.setenv("HERMES_TERN_LAUNCH_CWD", "/outer/cwd")
    if existing is None:
        monkeypatch.delenv("HERMES_TERN_RESTORED", raising=False)
    else:
        monkeypatch.setenv("HERMES_TERN_RESTORED", existing)
    monkeypatch.setattr(launcher.panes, "plan", lambda **kwargs: "fixture-root")
    saved_argv, saved_env = list(sys.argv), dict(os.environ)

    def broken(argv, env=None):
        assert argv[:2] == ["/bin/node", "--expose-gc"]
        assert env["HERMES_TERN_RESTORED"] == "fixture-root"
        assert json.loads(env["HERMES_TERN_CREATE"])["pass_session_id"] is True
        raise RuntimeError("unexpected launcher failure")

    monkeypatch.setattr(launcher.subprocess, "call", broken)
    with pytest.raises(RuntimeError, match="unexpected launcher failure"):
        launcher.run(parse(["--pass-session-id"]))
    assert sys.argv == saved_argv and dict(os.environ) == saved_env


def test_interrupt_exits_without_consuming_a_switch_request(launched, monkeypatch):
    def interrupted(*args, **kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr(launcher.subprocess, "call", interrupted)
    monkeypatch.setattr(launcher.channels, "pending_switch", lambda: pytest.fail("consumed a switch after interrupt"))
    with pytest.raises(SystemExit) as done:
        launcher.run(parse([]))
    assert done.value.code == 130
