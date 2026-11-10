"""Frontend channels and the live in-pane switch: same profile and session, another frontend."""

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import types
from pathlib import Path

import pytest

from hermes_tern_plugin import channels, launcher, plugin_data


@pytest.fixture(autouse=True)
def isolated_launch(tmp_path, monkeypatch):
    def _dir(name):
        path = tmp_path / "plugin-data" / name
        path.mkdir(parents=True, exist_ok=True)
        return path

    monkeypatch.setattr(plugin_data, "folder", _dir)
    own = tmp_path / "own-frontend"
    (own / "dist").mkdir(parents=True)
    (own / "dist" / "entry.js").write_text("")
    monkeypatch.setattr(launcher, "FRONTEND", own)
    monkeypatch.setattr(launcher, "node_binary", lambda: "/bin/node")
    monkeypatch.setattr(launcher, "hermes_command", lambda: {"argv": ["/py", "-m", "hermes_cli.main"]})
    monkeypatch.setattr(launcher, "client_env", lambda: {})
    monkeypatch.setattr(launcher, "_local_terminal", lambda: True)
    monkeypatch.setattr(launcher, "_session_cwd", lambda sid: None)
    monkeypatch.setattr(launcher, "resolve_session", lambda name: name)
    monkeypatch.setattr(launcher, "latest_session", lambda: "latest")
    monkeypatch.setattr(launcher.panes, "plan", lambda **kwargs: None)
    monkeypatch.setattr(launcher.pull_requests, "enterprise_hosts", lambda: [])
    monkeypatch.setitem(sys.modules, "hermes_constants", types.SimpleNamespace(get_hermes_home=lambda: tmp_path / "home"))


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


def test_channel_flag_is_parsed_by_the_launcher_without_changing_session_policy():
    args = parse(["-c", "--channel", "main", "-m", "x"])
    assert args.channel == "main" and args.continue_last is True and args.model == "x"
    assert launcher.create_options(args) == {"model": "x"}
    assert parse(["--channel=preview"]).channel == "preview"
    assert not hasattr(parse(["-c"]), "channel")


def test_unknown_channel_fails_naming_the_known_ones(registry):
    with pytest.raises(SystemExit, match="main, preview, upstream"):
        channels.frontend_dir("nope")


def parse(argv):
    parser = argparse.ArgumentParser()
    launcher.setup(parser)
    return parser.parse_args(argv)


def run(monkeypatch, argv, channel=None, codes=(0,)):
    calls, codes = [], list(codes)
    monkeypatch.delenv("TERN_PANE", raising=False)

    def node(command, env=None):
        calls.append((str(Path(command[-1]).parent.parent), dict(env)))
        return codes.pop(0) if codes else 0

    monkeypatch.setattr(launcher.subprocess, "call", node)
    with pytest.raises(SystemExit) as done:
        launcher.run(parse(argv), channel)
    assert done.value.code == 0
    return calls


def test_plain_tern_uses_the_default_channel_and_aliases_their_own(registry, monkeypatch):
    up, main = registry["channels"]["upstream"]["dir"], registry["channels"]["main"]["dir"]
    for argv, alias, expected, resume in [
        (["-c"], None, up, "latest"),
        (["-c"], "main", main, "latest"),
        (["--channel", "main"], None, main, None),
        (["--channel=main"], "preview", main, None),
    ]:
        [(front, env)] = run(monkeypatch, argv, channel=alias)
        assert front == os.path.join(expected, "frontend")
        assert env.get("HERMES_TERN_RESUME") == resume


def test_without_a_registry_tern_draws_its_own_frontend(monkeypatch):
    [(front, env)] = run(monkeypatch, ["-c"])
    assert front == str(launcher.FRONTEND)
    assert env["HERMES_TERN_RESUME"] == "latest"


def test_a_switch_request_relaunches_the_same_session_on_the_new_channel(registry, monkeypatch):
    folder = plugin_data.folder("panes")
    calls = []

    def node(command, env=None):
        calls.append((str(Path(command[-1]).parent.parent), dict(env)))
        if len(calls) == 1:  # `hermes tern switch preview` ran while this frontend drew
            (folder / "77.switch.json").write_text(json.dumps(
                {"channel": "preview", "session_id": "local-abc", "pid": 1, "at": time.time()}))
            return -signal.SIGTERM
        return 0

    monkeypatch.setenv("TERN_PANE", "77")
    monkeypatch.setattr(launcher.panes, "plan", lambda **kwargs: "root")
    monkeypatch.setattr(launcher.subprocess, "call", node)
    with pytest.raises(SystemExit) as done:
        launcher.run(parse(["-m", "x", "-q", "first prompt", "--image", "a.png"]))
    assert done.value.code == 0
    preview = os.path.join(registry["channels"]["preview"]["dir"], "frontend")
    assert calls[0][1]["HERMES_TERN_RESUME"] == calls[0][1]["HERMES_TERN_RESTORED"] == "root"
    front, env = calls[1]
    assert front == preview
    assert env["HERMES_TERN_RESUME"] == "local-abc"
    assert json.loads(env["HERMES_TERN_CREATE"])["model"] == "x"
    assert env["HERMES_HOME"] == calls[0][1]["HERMES_HOME"]
    assert env["HERMES_TERN_HERMES"] == calls[0][1]["HERMES_TERN_HERMES"]
    assert env["HERMES_TERN_LAUNCH_CWD"] == calls[0][1]["HERMES_TERN_LAUNCH_CWD"]
    assert not {"HERMES_TERN_RESTORED", "HERMES_TERN_QUERY", "HERMES_TERN_IMAGE"} & env.keys()
    assert not (folder / "77.switch.json").exists()


def test_a_stale_switch_request_is_ignored(registry, monkeypatch):
    folder = plugin_data.folder("panes")
    (folder / "5.switch.json").write_text(json.dumps(
        {"channel": "main", "session_id": "s", "at": time.time() - 3600}))
    assert channels.pending_switch({"TERN_PANE": "5"}) is None


def test_request_switch_stops_only_that_panes_frontend(registry, tmp_path):
    folder = plugin_data.folder("panes")
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
        proc.wait(timeout=3)


def test_channels_lists_without_a_bundle_or_node(registry, monkeypatch, capsys):
    monkeypatch.setattr(launcher, "FRONTEND", Path("/missing"))
    monkeypatch.setattr(launcher, "node_binary", lambda: pytest.fail("listing started Node"))
    launcher.run(parse(["channels"]))
    out = capsys.readouterr().out
    assert f"registry: {channels.registry_path()}" in out
    assert all(name in out for name in registry["channels"])
    assert "hermes mytern" in out and "hermes myternp" in out


@pytest.mark.parametrize("argv,pane", [(["switch", "preview"], "77"), (["switch", "preview", "--pane", "42"], "42")])
def test_switch_subcommand_targets_the_requested_pane(registry, monkeypatch, capsys, argv, pane):
    monkeypatch.setenv("TERN_PANE", "77")
    requested = []
    monkeypatch.setattr(channels, "request_switch", lambda name, target: requested.append((name, target)) or {"session_id": "s1"})
    monkeypatch.setattr(launcher, "node_binary", lambda: pytest.fail("switch command started Node"))
    launcher.run(parse(argv))
    assert requested == [("preview", pane)]
    assert f"pane {pane} -> channel preview (session s1)" in capsys.readouterr().out


def test_switch_subcommand_requires_a_numeric_pane(monkeypatch):
    monkeypatch.setattr(channels, "request_switch", lambda *args: pytest.fail("invalid pane requested"))
    with pytest.raises(SystemExit, match="usage:"):
        launcher.run(parse(["switch", "main"]))
    with pytest.raises(SystemExit, match="usage:"):
        launcher.run(parse(["switch", "main", "--pane", "../42"]))


@pytest.mark.parametrize("argv", [["--channel"], ["switch"], ["switch", "main", "--pane"], ["channels", "extra"]])
def test_channel_command_parser_rejects_incomplete_or_extra_arguments(argv):
    with pytest.raises(SystemExit) as done:
        parse(argv)
    assert done.value.code == 2


@pytest.mark.parametrize("switch_request", [[], {"at": "bad"}, {"at": time.time(), "channel": [], "session_id": "s1"}])
def test_malformed_switch_requests_are_consumed_without_a_relaunch(switch_request):
    path = plugin_data.folder("panes") / "77.switch.json"
    path.write_text(json.dumps(switch_request))
    assert channels.pending_switch({"TERN_PANE": "77"}) is None
    assert not path.exists()


def test_unknown_channel_fails_before_signalling_a_frontend(registry):
    with pytest.raises(SystemExit, match="no channel"):
        channels.request_switch("missing", "42", kill=lambda *args: pytest.fail("signalled"))
