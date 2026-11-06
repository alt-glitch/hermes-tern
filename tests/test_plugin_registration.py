"""register(ctx) wiring: everything goes through the public plugin API, under the names the manifest
declares (``hermes plugins validate`` checks the same against a live context)."""

from __future__ import annotations

import argparse
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
        "register_hook", "register_middleware", "register_gateway_method", "register_command", "on_unload"}


def test_the_tools_hook_and_middleware_are_the_declared_ones(ctx):
    tools = [k["name"] for _, k in ctx.of("register_tool")]
    assert tools == ["link_pull_request", "unlink_pull_request", "list_pull_requests"]
    assert f"provides_tools: [{', '.join(tools)}]" in MANIFEST
    assert [a[0] for a, _ in ctx.of("register_hook")] == ["transform_tool_result"]
    assert "provides_hooks: [transform_tool_result]" in MANIFEST
    assert [a[0] for a, _ in ctx.of("register_middleware")] == ["tool_request"]
    assert "provides_middleware: [tool_request]" in MANIFEST


def test_native_browser_registration_is_namespaced_and_read_only_without_consent(ctx):
    entries = [(args, kwargs) for args, kwargs in ctx.of('register_gateway_method') if args[0].startswith('hermes-tern.browser.')]
    assert [args[0] for args, _ in entries] == [
        f'hermes-tern.browser.{action}' for action in ('blocks', 'adopt', 'focus', 'release', 'frame')
    ]
    assert all('schema' in kwargs for _, kwargs in entries)
    assert [kwargs['name'] for _, kwargs in ctx.of('register_tool')] == [
        'link_pull_request', 'unlink_pull_request', 'list_pull_requests'
    ]


def test_the_tern_command_hands_its_flags_to_hermes_chat(ctx):
    ((_, cmd),) = ctx.of("register_cli_command")
    assert cmd["name"] == "tern"
    parser = argparse.ArgumentParser()
    cmd["setup_fn"](parser)
    assert parser.parse_args(["-c", "--image", "a.png"]).tui_args == ["-c", "--image", "a.png"]


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
