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
        "register_hook", "register_middleware"}


def test_the_tools_hook_and_middleware_are_the_declared_ones(ctx):
    tools = [k["name"] for _, k in ctx.of("register_tool")]
    assert tools == ["link_pull_request", "unlink_pull_request", "list_pull_requests"]
    assert f"provides_tools: [{', '.join(tools)}]" in MANIFEST
    assert [a[0] for a, _ in ctx.of("register_hook")] == ["transform_tool_result"]
    assert "provides_hooks: [transform_tool_result]" in MANIFEST
    assert [a[0] for a, _ in ctx.of("register_middleware")] == ["tool_request"]
    assert "provides_middleware: [tool_request]" in MANIFEST


def test_the_tern_command_hands_its_flags_to_hermes_chat(ctx):
    ((_, cmd),) = ctx.of("register_cli_command")
    assert cmd["name"] == "tern"
    parser = argparse.ArgumentParser()
    cmd["setup_fn"](parser)
    assert parser.parse_args(["-c", "--image", "a.png"]).tui_args == ["-c", "--image", "a.png"]


def test_the_chart_task_has_a_plugin_namespaced_key(ctx):
    ((args, kwargs),) = ctx.of("register_auxiliary_task")
    assert args[0] == "tern_charts" and kwargs["display_name"]
