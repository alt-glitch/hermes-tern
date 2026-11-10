"""register(ctx) wiring: everything goes through the public plugin API, under the names the manifest
declares (``hermes plugins validate`` checks the same against a live context)."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import pytest

import hermes_tern_plugin

MANIFEST = (Path(__file__).resolve().parents[1] / "plugin.yaml").read_text()


class RecordingCtx:
    def __init__(self):
        self.calls = []

    profile_name = 'fixture'

    def has_capability(self, capability):
        return False

    def on_unload(self, fn):
        self.calls.append(('on_unload', (fn,), {}))

    def __getattr__(self, name):
        if not name.startswith("register_"):
            raise AttributeError(name)
        return lambda *args, **kwargs: self.calls.append((name, args, kwargs))

    def of(self, kind):
        return [(a, k) for n, a, k in self.calls if n == kind]


@pytest.fixture
def ctx():
    c = RecordingCtx()
    hermes_tern_plugin.register(c)
    return c


def test_registers_only_public_plugin_apis(ctx):
    assert {n for n, _, _ in ctx.calls} == {
        "register_cli_command", "register_auxiliary_task", "register_tool", "register_system_prompt_section",
        "register_gateway_method", "register_command", "on_unload", "register_rpc", "register_session_env"}


def test_the_tools_are_the_declared_ones_and_there_is_no_hook_or_middleware(ctx):
    tools = [k["name"] for _, k in ctx.of("register_tool")]
    assert tools == ["link_pull_request", "unlink_pull_request", "list_pull_requests"]
    assert f"provides_tools: [{', '.join(tools)}]" in MANIFEST
    assert not ctx.of("register_hook") and "provides_hooks" not in MANIFEST
    assert not ctx.of("register_middleware") and "provides_middleware" not in MANIFEST


def test_native_browser_registration_is_namespaced_and_read_only_without_consent(ctx):
    entries = [(args, kwargs) for args, kwargs in ctx.of('register_gateway_method') if args[0].startswith('hermes-tern.browser.')]
    assert [args[0] for args, _ in entries] == [
        f'hermes-tern.browser.{action}' for action in ('blocks', 'adopt', 'focus', 'release', 'frame')
    ]
    assert all('schema' in kwargs for _, kwargs in entries)
    assert [kwargs['name'] for _, kwargs in ctx.of('register_tool')] == [
        'link_pull_request', 'unlink_pull_request', 'list_pull_requests'
    ]


def test_the_frontend_names_itself_with_the_plugins_version():
    # The frontend sends its package version as `client.version` on session.create.
    frontend = json.loads((Path(__file__).resolve().parents[1] / "frontend" / "package.json").read_text())
    assert re.search(r"^version: (\S+)$", MANIFEST, re.M).group(1) == frontend["version"]


def test_the_tern_command_parses_its_own_flags(ctx):
    ((_, cmd),) = ctx.of("register_cli_command")
    assert cmd["name"] == "tern"
    parser = argparse.ArgumentParser()
    cmd["setup_fn"](parser)
    args = parser.parse_args(["-c", "--image", "a.png"])
    assert args.continue_last is True and args.image == "a.png"


def test_chart_tasks_keep_their_explicit_plugin_keys(ctx):
    tasks = {args[0]: kwargs for args, kwargs in ctx.of("register_auxiliary_task")}
    assert set(tasks) == {"tern_charts", "table_charts"}
    assert all(task["display_name"] for task in tasks.values())


def test_only_real_safe_report_is_registered_until_btw_owner_seam(ctx):
    ((args, kwargs),) = [(args, kwargs) for args, kwargs in ctx.of("register_gateway_method")
                        if args[0] == "hermes-tern.operations.report"]
    assert args[0] == "hermes-tern.operations.report"
    assert callable(args[1]) and kwargs["schema"].model_config["extra"] == "forbid"


def test_an_old_runtime_still_registers_its_normal_plugin_commands():
    class OldContext(RecordingCtx):
        def __getattr__(self, name):
            if name == "register_gateway_method":
                raise AttributeError(name)
            return super().__getattr__(name)

    old = OldContext()
    hermes_tern_plugin.register(old)
    assert not old.of("register_gateway_method")
    assert old.of("register_cli_command")


def test_plan_methods_use_only_owned_public_gateway_registration(ctx):
    methods = [(args[0], args[1], kwargs["schema"])
               for args, kwargs in ctx.of("register_gateway_method")
               if args[0].startswith("hermes-tern.plan.")]
    assert [name for name, _, _ in methods] == [
        "hermes-tern.plan.status", "hermes-tern.plan.mode", "hermes-tern.plan.edit",
        "hermes-tern.plan.annotate", "hermes-tern.plan.decide",
    ]
    assert all(callable(handler) and schema is not None
               for _, handler, schema in methods)


def test_older_plugin_context_does_not_advertise_plan_authority():
    class OldCtx(RecordingCtx):
        def __getattr__(self, name):
            if name == "register_gateway_method":
                raise AttributeError(name)
            return super().__getattr__(name)

    old = OldCtx()
    hermes_tern_plugin.register(old)
    assert not old.of("register_gateway_method")


def test_registered_media_gateway_methods_are_strict_and_owned(ctx):
    from hermes_tern_plugin import media_backend

    methods = [(args, kwargs) for args, kwargs in ctx.of("register_gateway_method") if args[0].startswith("hermes-tern.media.")]
    assert [args[0] for args, _ in methods] == [
        "hermes-tern.media.image", "hermes-tern.media.attach_bytes"
    ]
    assert [args[1] for args, _ in methods] == [
        media_backend.read_image, media_backend.attach_bytes
    ]
    assert all(kwargs["schema"].model_config.get("extra") == "forbid"
               for _, kwargs in methods)


def test_media_registration_degrades_on_unpinned_older_hermes():
    class OldContext(RecordingCtx):
        register_gateway_method = None

    ctx = OldContext()
    hermes_tern_plugin.register(ctx)
    assert not ctx.of("register_gateway_method")
    assert ctx.of("register_cli_command")


def test_ephemeral_ui_prompt_lists_every_pinned_kind(ctx):
    from hermes_tern_plugin import ephemeral_cards

    sections = {a[0]: a[1] for a, _ in ctx.of("register_system_prompt_section")}
    text = sections["hermes-tern.ephemeral-ui"]
    kinds = ephemeral_cards.kinds()
    assert len(kinds) == 50
    assert len(text) < 4000
    assert all(f"{k}(" in text for k in kinds)
    assert "synthetic demo content" in text


def test_the_chart_task_has_a_plugin_namespaced_key(ctx):
    ((args, kwargs),) = [(a, k) for a, k in ctx.of("register_auxiliary_task") if a[0] == "tern_charts"]
    assert args[0] == "tern_charts" and kwargs["display_name"]


def test_the_chart_writer_is_a_plugin_rpc_method(ctx):
    assert [a[0] for a, _ in ctx.of("register_rpc")] == [
        "charts.author", "pull_requests.linked", "viewer.set", "viewer.clear", "viewer.shown"]


def test_channel_aliases_bind_their_own_channel_and_use_the_launcher(monkeypatch):
    from hermes_tern_plugin import channels, launcher

    monkeypatch.setattr(channels, "aliases", lambda: {"mytern": "main", "myternp": "preview"})
    ctx = RecordingCtx()
    hermes_tern_plugin.register(ctx)
    commands = {kwargs["name"]: kwargs for _, kwargs in ctx.of("register_cli_command")}
    assert set(commands) == {"tern", "mytern", "myternp"}
    assert commands["tern"]["handler_fn"] is launcher.run
    calls = []
    monkeypatch.setattr(launcher, "run", lambda args, channel=None: calls.append((args, channel)))
    for alias, expected in [("mytern", "main"), ("myternp", "preview")]:
        parser = argparse.ArgumentParser()
        commands[alias]["setup_fn"](parser)
        args = parser.parse_args(["--channel", "explicit", "--resume", "s1"])
        commands[alias]["handler_fn"](args)
        assert calls[-1] == (args, expected)
        assert args.channel == "explicit" and args.resume == "s1"
        assert commands[alias]["setup_fn"] is launcher.setup


def test_talk_command_and_owned_unload_are_preserved(ctx):
    from hermes_tern_plugin import talk_backend

    ((args, kwargs),) = ctx.of("register_command")
    assert args == ("tern-talk",)
    assert kwargs["handler"] == talk_backend._controller.command
    assert kwargs["args_hint"] == "start|status|stop CALL_ID"
    assert any(args == (talk_backend._controller.close,) for args, _ in ctx.of("on_unload"))
