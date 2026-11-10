"""Real green Hermes JSON-RPC registry and authorization pipeline gates.

Run with PYTHONPATH set to Hermes PR650's exact source checkout. The tests use
temporary profile homes, fake transports and fake Tern CLI; no live panes or
clean user profile are read or mutated.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import os
import queue
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from hermes_tern_plugin import browser_backend as backend
from hermes_tern_plugin import browser_native as native
from hermes_tern_plugin import tern_env, viewers
from hermes_tern_plugin.browser_transport import NativeBrowserError

_REAL_PANE_ENV = tern_env.pane_env
_REAL_VIEWER = backend._viewer
_REAL_CDP_SELECTED = backend._cdp_selected


class Peer:
    def __init__(self):
        self.frames = queue.Queue()
        self.closed = False

    def write(self, frame):
        if self.closed:
            return False
        self.frames.put(frame)
        return True

    def receive(self):
        return self.frames.get(timeout=5)

    def close(self):
        self.closed = True


class ReadOnlyCLI:
    calls = 0

    def __init__(self, *_args):
        pass

    def __call__(self, op):
        type(self).calls += 1
        assert op == {"op": "blocks"}
        return {"blocks": [{
            "block": 7, "title": "Private title", "url": "https://example.org/",
            "owner": None, "driven": False,
        }]}


def attach(server, sid, peer, home=None):
    server._sessions[sid] = {
        "transport": peer, "profile_home": home, "session_key": f"durable-{sid}",
        "agent": SimpleNamespace(session_id=f"tool-{sid}"),
        "history": [], "history_lock": threading.Lock(), "running": False,
    }


def rpc(server, peer, method, rid=1, **params):
    message = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}
    immediate = server.dispatch(message, peer)
    if immediate is not None:
        return immediate
    while True:
        response = peer.receive()
        if response.get("id") == rid:
            return response


@pytest.fixture
def green(tmp_path, monkeypatch):
    from tui_gateway import server
    from hermes_cli import plugins
    from hermes_tern_plugin import tern_env

    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setattr(server, "_hermes_home", home)
    monkeypatch.setattr(server, "_sessions", {})
    monkeypatch.setattr(viewers, "_viewers", {})
    monkeypatch.setattr(tern_env, "_ids", {})
    plugins._reset_plugin_managers_for_tests()
    monkeypatch.setattr(plugins, "discover_plugins", lambda force=False: None)

    ReadOnlyCLI.calls = 0
    monkeypatch.setattr(backend, "TernBrowserCLI", ReadOnlyCLI)
    monkeypatch.setattr(backend, "_cdp_selected", lambda: False)
    view = {"TERN_PANE": "3", "TERN_WINDOW_KEY": "isolated-window"}
    monkeypatch.setattr(tern_env, "pane_env", lambda sid: dict(view))
    monkeypatch.setattr(backend, "_viewer", lambda sid: (
        3, "isolated-window", tuple(sorted(view.items())),
        {"HOME": str(home)}, "tern", ("isolated-window", "daemon", "config"),
    ))

    manager = plugins.get_plugin_manager()
    ctx = plugins.PluginContext(plugins.PluginManifest(name="hermes-tern"), manager)
    backend.register(ctx)
    yield server, manager, plugins, home
    manager.unload("hermes-tern")
    plugins._reset_plugin_managers_for_tests()
    native._DRIVERS.clear()


def test_real_registered_plugin_names_and_live_transport(green):
    server, manager, _, _ = green
    attached = Peer()
    foreign = Peer()
    attach(server, "s1", attached)
    attach(server, "s2", foreign)
    names = rpc(server, attached, "gateway.capabilities", session_id="s1")["result"]["plugin_methods"]
    assert names == sorted([
        "hermes-tern.browser.blocks", "hermes-tern.browser.adopt",
        "hermes-tern.browser.focus", "hermes-tern.browser.release",
        "hermes-tern.browser.frame",
    ])

    found = rpc(server, attached, "hermes-tern.browser.blocks", session_id="s1")
    assert found["result"]["available"] is False  # no operator tool override grant
    assert found["result"]["blocks"][0]["target_id"] == "7"
    assert ReadOnlyCLI.calls == 1
    assert rpc(server, foreign, "hermes-tern.browser.blocks", session_id="s1")["error"]["code"] == 4001
    assert rpc(server, attached, "gateway.capabilities", session_id="s2")["error"]["code"] == 4001
    assert rpc(server, attached, "hermes-tern.browser.adopt", session_id="s1",
               target_id="7")["error"]["code"] in {4001, -32000}
    assert ReadOnlyCLI.calls == 1  # refusal had NO native adoption


def test_real_registered_plugin_refuses_client_profile_and_detach(green):
    server, manager, _, _ = green
    peer = Peer()
    attach(server, "s1", peer)
    for method in ("gateway.capabilities", "hermes-tern.browser.blocks"):
        reply = rpc(server, peer, method, session_id="s1", profile="other")
        assert reply["error"]["code"] == 4001
    old = server._sessions.pop("s1")
    assert rpc(server, peer, "hermes-tern.browser.blocks",
               session_id="s1")["error"]["code"] == 4001
    attach(server, "s1", Peer())
    assert rpc(server, peer, "hermes-tern.browser.blocks",
               session_id="s1")["error"]["code"] == 4001
    assert ReadOnlyCLI.calls == 0


def test_real_registered_plugin_isolated_second_profile(green):
    server, manager, plugins, home = green
    one = Peer()
    two = Peer()
    profile_home = home / "profiles" / "work"
    profile_home.mkdir(parents=True)
    (profile_home / "config.yaml").write_text("{}\n", encoding="utf-8")
    attach(server, "default-owned", one)
    attach(server, "work-owned", two, str(profile_home))
    names = rpc(server, one, "gateway.capabilities",
                session_id="default-owned")["result"]["plugin_methods"]
    assert "hermes-tern.browser.blocks" in names
    foreign_methods = rpc(server, two, "gateway.capabilities",
                          session_id="work-owned")["result"]["plugin_methods"]
    assert "hermes-tern.browser.blocks" not in foreign_methods
    assert rpc(server, two, "hermes-tern.browser.blocks",
               session_id="work-owned")["error"]["code"] == -32601
    assert rpc(server, one, "hermes-tern.browser.blocks",
               session_id="work-owned")["error"]["code"] == 4001


def test_real_gateway_unload_revokes_registration(green):
    server, manager, _, _ = green
    peer = Peer()
    attach(server, "s1", peer)
    assert rpc(server, peer, "gateway.capabilities",
               session_id="s1")["result"]["plugin_methods"]
    assert manager.unload("hermes-tern")
    assert rpc(server, peer, "gateway.capabilities",
               session_id="s1")["result"]["plugin_methods"] == []
    assert rpc(server, peer, "hermes-tern.browser.blocks",
               session_id="s1")["error"]["code"] == -32601



class ActiveCLI:
    """No subprocesses; counts real registered-dispatch CLI effects exactly."""
    instances = []

    def __init__(self, *_args):
        self.calls = []
        self.unknown = False
        self.pending = None
        self.instances.append(self)

    def __call__(self, op):
        self.calls.append(dict(op))
        action = op["op"]
        if action == "blocks":
            return {"blocks": [{"block": 7, "title": "Owned test page",
                                "url": "https://example.org/", "owner": None,
                                "driven": False}]}
        if action == "snapshot":
            return {"text": "document"}
        if action == "state":
            return {"title": "Owned test page", "url": "https://example.org/"}
        if action in {"release", "close"}:
            return {"released": True}
        if action == "eval":
            return {"value": "https://example.org/"}
        raise AssertionError(f"unexpected native operation: {action}")

    def invoke(self, argv):
        self.calls.append({"focus": list(argv)})
        return {}


def _consent(home, enabled: bool):
    """Write the isolated profile through Hermes' real config API (cache invalidation)."""
    from hermes_cli.config import save_config

    assert home.is_dir()
    save_config({"plugins": {"entries": {
        "hermes-tern": {"allow_tool_override": enabled},
    }}}, strip_defaults=False)


def _reload_granted(manager, plugins, home, monkeypatch):
    from tools.registry import registry

    importlib.import_module("tools.browser_tool")
    _consent(home, True)
    assert manager.unload("hermes-tern")
    ActiveCLI.instances.clear()
    monkeypatch.setattr(backend, "TernBrowserCLI", ActiveCLI)
    ctx = plugins.PluginContext(plugins.PluginManifest(name="hermes-tern"), manager)
    assert ctx.has_capability("tools.override") is True
    backend.register(ctx)
    for name in backend._TOOL_NAMES:
        selected = registry.get_entry(name)
        assert selected is not None
        assert selected.handler is backend._NATIVE_HANDLERS[ctx.profile_name][name]
    return ctx


@pytest.mark.parametrize(("ownership", "operation", "block"), [
    ("created", "close", 10), ("adopted", "release", 7),
])
def test_real_unload_cleanup_before_native_registry_disposal(
    green, monkeypatch, ownership, operation, block,
):
    """Cleanup actually executes while original selected handlers/grant remain."""
    from tools.registry import registry

    server, manager, plugins, home = green
    ctx = _reload_granted(manager, plugins, home, monkeypatch)

    class ObservedCLI(ActiveCLI):
        def __call__(self, op):
            if op["op"] == "open":
                self.calls.append(dict(op))
                return {"block": 10}
            if op["op"] == "goto":
                self.calls.append(dict(op))
                return {"url": op["url"]}
            if op["op"] in {"close", "release"}:
                assert ctx.has_capability("tools.override")
                assert backend._native_tools_ready(ctx, "default")
                assert registry.get_entry("browser_snapshot").handler is (
                    backend._NATIVE_HANDLERS["default"]["browser_snapshot"]
                )
            return super().__call__(op)

    monkeypatch.setattr(backend, "TernBrowserCLI", ObservedCLI)
    peer = Peer()
    attach(server, "s1", peer)
    assert rpc(server, peer, "hermes-tern.browser.blocks", session_id="s1")[
        "result"
    ]["available"]
    driver = native.get_driver("default", "s1")
    assert driver is not None
    cli = driver.scope.cli
    if ownership == "created":
        handler = registry.get_entry("browser_navigate").handler
        response = json.loads(handler(
            {"url": "https://example.org/"}, session_id="tool-s1", task_id="durable-s1",
        ))
        assert response["success"], response
        assert driver.target.block == 10 and driver.target.adopted is False
    else:
        adopted = rpc(server, peer, "hermes-tern.browser.adopt", session_id="s1", target_id="7")
        assert adopted["result"]["target_id"] == "7", adopted
        assert driver.target.block == 7 and driver.target.adopted is True
    before = list(cli.calls)
    assert manager.unload("hermes-tern")
    assert cli.calls == before + [{"op": operation, "block": block}]
    assert native.get_driver("default", "s1") is None
    assert driver.retired is False
    assert "default" not in backend._NATIVE_HANDLERS


def test_real_native_navigate_redacts_and_truncates_page_snapshot(green, monkeypatch):
    """Actual model registry handler and core redaction/truncation, no raw spill."""
    from tools.registry import registry
    from tools import browser_tool as browser

    server, manager, plugins, home = green
    _reload_granted(manager, plugins, home, monkeypatch)
    secret = "sk-" + "V" * 42
    huge = "title: safe\nAPI_KEY=" + secret + "\n" + "a" * 24000
    monkeypatch.setattr(browser, "get_browser_snapshot_threshold", lambda: 1000)

    class SecretCLI(ActiveCLI):
        def __call__(self, op):
            if op["op"] == "open":
                self.calls.append(dict(op))
                return {"block": 10}
            if op["op"] == "goto":
                self.calls.append(dict(op))
                return {"url": op["url"]}
            if op["op"] == "snapshot":
                self.calls.append(dict(op))
                return {"text": huge}
            return super().__call__(op)

    monkeypatch.setattr(backend, "TernBrowserCLI", SecretCLI)
    peer = Peer()
    attach(server, "s1", peer)
    assert rpc(server, peer, "hermes-tern.browser.blocks", session_id="s1")[
        "result"
    ]["available"]
    navigate = registry.get_entry("browser_navigate").handler
    response = json.loads(navigate(
        {"url": "https://example.org/"}, session_id="tool-s1", task_id="durable-s1",
    ))
    assert response["success"], response
    assert secret not in json.dumps(response)
    assert len(response["snapshot"]) < len(huge)
    assert "truncated" in response["snapshot"]
    snap = registry.get_entry("browser_snapshot").handler
    refreshed = json.loads(snap(
        {"full": True}, session_id="tool-s1", task_id="durable-s1",
    ))
    assert refreshed["success"], refreshed
    assert secret not in json.dumps(refreshed)
    assert len(refreshed["snapshot"]) < len(huge)
    assert "truncated" in refreshed["snapshot"]


@pytest.mark.parametrize("transition", ["revoke", "cdp", "replace"])
def test_real_unload_refuses_cleanup_after_authority_loss(green, monkeypatch, transition):
    """All three authority changes leave exact original claims and zero effects."""
    from tools.registry import registry

    server, manager, plugins, home = green
    ctx = _reload_granted(manager, plugins, home, monkeypatch)
    peer = Peer()
    attach(server, "s1", peer)
    assert rpc(server, peer, "hermes-tern.browser.blocks", session_id="s1")[
        "result"
    ]["available"]
    adopted = rpc(server, peer, "hermes-tern.browser.adopt", session_id="s1", target_id="7")
    assert adopted["result"]["target_id"] == "7", adopted
    driver = native.get_driver("default", "s1")
    assert driver is not None
    cli = driver.scope.cli
    before = list(cli.calls)
    if transition == "revoke":
        _consent(home, False)
    elif transition == "cdp":
        monkeypatch.setattr(backend, "_cdp_selected", _REAL_CDP_SELECTED)
        monkeypatch.setenv("BROWSER_CDP_URL", "http://127.0.0.1:9222")
        assert backend._cdp_selected()
    else:
        # A separately registered, truly selected handler cannot be invalidated
        # by undoing Hermes-tern's own registrations before cleanup.
        entry = registry.get_entry("browser_snapshot")
        def replacement(*_args, **_kwargs):
            raise AssertionError("replacement must not be called")
        from hermes_cli.config import save_config
        save_config({"plugins": {"entries": {
            "hermes-tern": {"allow_tool_override": True},
            "other-browser": {"allow_tool_override": True},
        }}}, strip_defaults=False)
        other = plugins.PluginContext(plugins.PluginManifest(name="other-browser"), manager)
        assert other.has_capability("tools.override")
        handle = other.register_tool(
            name=entry.name, toolset=entry.toolset, schema=entry.schema,
            handler=replacement, check_fn=entry.check_fn,
            requires_env=entry.requires_env, is_async=entry.is_async,
            description=entry.description, emoji=entry.emoji, override=True,
        )
        assert handle is not None
        assert registry.get_entry("browser_snapshot").handler is replacement

    assert manager.unload("hermes-tern")
    assert cli.calls == before
    assert driver.retired and driver.target.block == 7 and driver.target.adopted
    assert native.get_driver("default", "s1") is driver
    assert native.has_quarantined_task("default", "durable-s1")
    assert not backend._NATIVE_HANDLERS.get("default")
    # Returned consent or CDP preferences cannot revive the disposed lease.
    if transition == "revoke":
        _consent(home, True)
    elif transition == "cdp":
        monkeypatch.delenv("BROWSER_CDP_URL")
    else:
        assert manager.unload("other-browser")
    backend.register(plugins.PluginContext(plugins.PluginManifest(name="hermes-tern"), manager))
    listing = rpc(server, peer, "hermes-tern.browser.blocks", session_id="s1")
    assert listing["result"] == {
        "available": False, "blocks": [], "reason": "permanently_quarantined",
    }
    assert cli.calls == before


def test_public_context_consent_grant_revoke_reload_and_registry_identity(green, monkeypatch):
    """Consent appearing later cannot silently enable a CLI backend with old handlers."""
    from hermes_cli import plugins
    from tools.registry import registry

    server, manager, _, home = green
    importlib.import_module("tools.browser_tool")
    original = {name: registry.get_entry(name).handler for name in backend._TOOL_NAMES}
    peer = Peer()
    attach(server, "s1", peer)
    absent = plugins.PluginContext(plugins.PluginManifest(name="hermes-tern"), manager)
    assert absent.has_capability("tools.override") is False
    _consent(home, True)
    assert absent.has_capability("tools.override") is True
    assert all(registry.get_entry(name).handler is old for name, old in original.items())
    still_missing = rpc(server, peer, "hermes-tern.browser.blocks", session_id="s1")
    assert still_missing["result"]["reason"] == "needs_plugin_reload"
    assert still_missing["result"]["available"] is False
    assert still_missing["result"]["blocks"][0]["target_id"] == "7"
    assert native.get_driver("default", "s1") is None
    denied = rpc(server, peer, "hermes-tern.browser.adopt", session_id="s1", target_id="7")
    assert denied["error"]["code"] == -32000
    assert all(registry.get_entry(name).handler is old for name, old in original.items())

    ctx = _reload_granted(manager, plugins, home, monkeypatch)
    assert rpc(server, peer, "hermes-tern.browser.blocks", session_id="s1")["result"]["available"] is True
    driver = native.get_driver("default", "s1")
    assert driver is not None and driver.scope.lease is not None
    assert ActiveCLI.instances[0].calls == [{"op": "blocks"}]
    adopted = rpc(server, peer, "hermes-tern.browser.adopt", session_id="s1", target_id="7")
    assert adopted["result"]["target_id"] == "7"
    assert driver.scope.cli is ActiveCLI.instances[0]
    initial = list(driver.scope.cli.calls)

    _consent(home, False)
    assert ctx.has_capability("tools.override") is False
    refused = rpc(server, peer, "hermes-tern.browser.focus", session_id="s1", target_id="7")
    assert refused["error"]["code"] == -32000
    selected = registry.get_entry("browser_click")
    assert selected is not None and selected.handler is backend._NATIVE_HANDLERS["default"]["browser_click"]
    tool = json.loads(selected.handler({"ref": "@e1"}, session_id="tool-s1", task_id="durable-s1"))
    assert tool["error_kind"] == "unsupported"
    assert driver.scope.cli.calls == initial  # not a native focus or wrong-backend effect

    assert manager.unload("hermes-tern")
    assert all(registry.get_entry(name).handler is old for name, old in original.items())
    assert "default" not in backend._NATIVE_HANDLERS
    reloaded_without_grant = plugins.PluginContext(
        plugins.PluginManifest(name="hermes-tern"), manager)
    backend.register(reloaded_without_grant)
    assert all(registry.get_entry(name).handler is old for name, old in original.items())


def test_real_legacy_original_caller_survives_mirror_denial_then_detach(green, monkeypatch):
    """Original lease and effects through the real registered legacy dispatcher."""
    from tui_gateway.transport import FanoutTransport

    server, manager, plugins, home = green
    _reload_granted(manager, plugins, home, monkeypatch)
    a, b = Peer(), Peer()
    fanout = FanoutTransport(a, b)
    attach(server, "s1", fanout)
    assert rpc(server, a, "hermes-tern.browser.blocks", session_id="s1")["result"]["available"] is True
    driver = native.get_driver("default", "s1")
    lease = driver.scope.lease
    calls = list(driver.scope.cli.calls)

    for action, parameters in (
        ("blocks", {}),
        ("adopt", {"target_id": "7"}),
        ("focus", {"target_id": "7"}),
        ("release", {"target_id": "7"}),
        ("frame", {"target_id": "7", "frame": "main"}),
    ):
        result = rpc(server, b, f"hermes-tern.browser.{action}", session_id="s1", **parameters)
        assert result["error"]["code"] == -32000, result
    assert driver.scope.cli.calls == calls
    assert native.get_driver("default", "s1").scope.lease is lease
    assert rpc(server, a, "hermes-tern.browser.adopt",
               session_id="s1", target_id="7")["result"]["target_id"] == "7"
    assert native.get_driver("default", "s1").scope.lease is lease
    assert rpc(server, a, "hermes-tern.browser.focus",
               session_id="s1", target_id="7")["result"]["in_tern"] is True
    assert {"focus": ["focus", "7", "--json"]} in driver.scope.cli.calls

    assert fanout.detach(a)
    assert fanout.attach(a)
    calls = list(driver.scope.cli.calls)
    assert rpc(server, a, "hermes-tern.browser.release",
               session_id="s1", target_id="7")["error"]["code"] == -32000
    assert driver.scope.cli.calls == calls

    # The legacy session record is no longer active. Neither a stale peer
    # nor another viewer may issue an RPC effect after the slot disappears.
    server._sessions.pop("s1")
    assert rpc(server, b, "hermes-tern.browser.focus",
               session_id="s1", target_id="7")["error"]["code"] == 4001
    assert driver.scope.cli.calls == calls


@pytest.mark.parametrize("revocation", ["generation", "real_rewind"])
@pytest.mark.asyncio
async def test_real_canonical_no_task_accessor_even_after_generation_change(
    green, monkeypatch, revocation,
):
    """Actual canonical dispatcher and rewind: do not fabricate task authority."""
    from gateway.session_authority import LiveSession, SessionAuthority
    from hermes_state import SessionDB
    from hermes_state_runtime import begin_runtime_epoch
    from tui_gateway.ws import _authority_connection, _dispatch_request

    _, manager, plugins, home = green
    _reload_granted(manager, plugins, home, monkeypatch)
    db = SessionDB(db_path=home / "state.db")
    db.create_session("canon", source="test")
    runner = SimpleNamespace(_draining=False, config=SimpleNamespace(multiplex_profiles=False))
    authority = SessionAuthority(
        runner, profile_id=str(home), instance_id="isolated", db=db,
        epoch=begin_runtime_epoch(db, instance_id="isolated"),
    )
    authority.sessions["canon"] = LiveSession(None, "route")

    class Transport:
        def __init__(self):
            self.frames = []
            self.closed = False

        def write(self, frame):
            if self.closed:
                return False
            self.frames.append(frame)
            return True

    def connect(subject):
        identity = {
            "user_id": subject, "provider": "local", "native_bootstrap": True,
            "profile_id": authority.profile_id, "instance_id": authority.instance_id,
        }
        return _authority_connection(
            SimpleNamespace(scope={"hermes.session_authority": authority}),
            Transport(), identity, operator=True,
        )

    async def call(peer, method, **params):
        return await _dispatch_request(
            peer, {"jsonrpc": "2.0", "id": 1, "method": method,
                   "params": params}, method, peer.transport,
        )

    a, b = connect("a"), connect("b")
    try:
        for peer in (a, b):
            assert "result" in await call(peer, "session.resume", session_id="canon")
        initial = await call(a, "hermes-tern.browser.blocks", session_id="canon")
        assert initial["result"] == {
            "available": False, "blocks": [], "reason": "task_authority_unavailable",
        }
        assert native.get_driver("default", "canon") is None
        for action, params in (
            ("adopt", {"target_id": "7"}), ("focus", {"target_id": "7"}),
            ("release", {"target_id": "7"}), ("frame", {"target_id": "7", "frame": "main"}),
        ):
            result = await call(a, f"hermes-tern.browser.{action}", session_id="canon", **params)
            assert "error" in result, result
        assert not ActiveCLI.instances

        if revocation == "generation":
            db._execute_write(lambda conn: conn.execute(
                "UPDATE sessions SET runtime_generation=runtime_generation+1 WHERE id=?",
                ("canon",),
            ))
        else:
            runner._evict_cached_agent = lambda route: None
            target_id = await asyncio.to_thread(
                db.append_message, "canon", "user", "browser rewind target")
            snapshot = await asyncio.to_thread(db.get_session, "canon")
            rewind = await call(
                a, "session.mutate", session_id="canon",
                request_id="browser-caller-rewind",
                expected_revision=snapshot["runtime_revision"],
                expected_generation=snapshot["runtime_generation"],
                operation="rewind", payload={"target_message_id": target_id},
            )
            assert "result" in rewind, rewind
            assert rewind["result"]["execution_generation"] == (
                snapshot["runtime_generation"] + 1
            )
        stale = await call(a, "hermes-tern.browser.blocks", session_id="canon")
        assert "error" in stale or stale["result"]["available"] is False
        assert not ActiveCLI.instances and not native._DRIVERS
    finally:
        await a.close()
        await b.close()
        db.close()


@pytest.mark.parametrize("denial", ["scope", "pre_hook", "guardrail"])
def test_real_hermes_policy_deny_before_native_effect(monkeypatch, denial):
    from agent import tool_executor as executor
    effects = []
    posts = []
    monkeypatch.setattr(executor, "_emit_terminal_post_tool_call",
                        lambda *args, **kwargs: posts.append(kwargs))
    denied = SimpleNamespace(allows_execution=False, message="denied")
    agent = SimpleNamespace(
        _tool_guardrails=SimpleNamespace(
            before_call=lambda name, args: denied if denial == "guardrail"
            else SimpleNamespace(allows_execution=True)),
        _guardrail_block_result=lambda decision: '{"error":"denied"}',
    )
    monkeypatch.setattr(
        executor, "_pre_tool_block",
        lambda agent, ref: ("hook rejected", ref.args) if denial == "pre_hook"
        else (None, ref.args),
    )
    args = {"ref": "@e1"}
    state = executor._ManagedToolResult(
        result=None, args=args, middleware_trace=[], blocked=False, dispatched=False,
    )
    ref = executor._ToolCallRef("browser_click", args, "task", "call", [])
    result = executor._dispatch_authorized_once(
        agent, state, ref,
        execute=lambda kwargs: effects.append(kwargs),
        scope_block="scope denied" if denial == "scope" else None,
        display_index=None, begin_execution=None, authorization_gate=None,
    )
    assert "denied" in str(result) or "rejected" in str(result)
    assert state.blocked
    assert not effects
    assert len(posts) == 1


def test_native_registry_availability_without_external_browser(green, monkeypatch):
    """Original browser requirements false; registry schema accepts only commissioned Tern."""
    from tools import browser_tool as browser
    from tools.registry import registry

    server, manager, plugins, home = green
    monkeypatch.setattr(browser, "check_browser_routed_requirements",
                        lambda action="browser_snapshot": False)
    monkeypatch.setattr(browser._install, "check_browser_requirements", lambda: False)
    monkeypatch.setattr(browser._install, "check_browser_vision_requirements", lambda: False)
    _reload_granted(manager, plugins, home, monkeypatch)
    peer = Peer()
    attach(server, "s1", peer)
    selected = [registry.get_entry(name) for name in backend._TOOL_NAMES]
    assert all(e is not None and callable(e.check_fn) for e in selected)
    # Routed originals honor the simulated absent extension/browser.
    routed = selected[:7]
    assert all(not e.check_fn() for e in routed)
    # Separate false-original witness also covers the three plain probes,
    # independent of dependencies possibly installed on OMP's test host.
    native_only = backend._native_availability(
        plugins.PluginContext(plugins.PluginManifest(name="hermes-tern"), manager),
        lambda: False,
    )
    assert native_only() is False
    assert not ActiveCLI.instances

    found = rpc(server, peer, "hermes-tern.browser.blocks", session_id="s1")
    assert found["result"]["available"], found
    driver = native.get_driver("default", "s1")
    assert driver is not None
    baseline = list(driver.scope.cli.calls)
    assert baseline == [{"op": "blocks"}]
    from gateway.session_context import scoped_current_session_id, scoped_session_key

    # Another session's commissioned native driver is not availability proof.
    assert not any(e.check_fn() for e in routed)
    assert native_only() is False
    with scoped_current_session_id("tool-s2"), scoped_session_key("durable-s2"):
        assert not any(e.check_fn() for e in routed)
        assert native_only() is False
    with scoped_current_session_id("wrong-tool"), scoped_session_key("durable-s1"):
        assert not any(e.check_fn() for e in routed)
    with scoped_current_session_id("tool-s1"), scoped_session_key("durable-s1"):
        assert all(e.check_fn() for e in selected)
        assert native_only() is True
        schemas = registry.get_definitions(set(backend._TOOL_NAMES))
        assert {schema["function"]["name"] for schema in schemas} == set(backend._TOOL_NAMES)
    assert driver.scope.cli.calls == baseline  # schema assembly causes zero CLI effects

    assert rpc(server, peer, "hermes-tern.browser.adopt",
               session_id="s1", target_id="7")["result"]["target_id"] == "7"
    before = list(driver.scope.cli.calls)
    _consent(home, False)
    with scoped_current_session_id("tool-s1"), scoped_session_key("durable-s1"):
        assert not any(e.check_fn() for e in routed)
        assert native_only() is False
    assert driver.scope.cli.calls == before


class InterleavedOpenCLI(ActiveCLI):
    """One authorized blank-page open, followed by a live authority change."""

    after_open = None

    def __call__(self, op):
        if op["op"] != "open":
            return super().__call__(op)
        assert op == {"op": "open", "owner": 3, "url": "about:blank"}
        self.calls.append(dict(op))
        callback = type(self).after_open
        assert callable(callback)
        callback()
        return {"block": 10}


@pytest.mark.parametrize(
    ("transition", "refusal"),
    [("revoke", "unsupported"), ("replace", "unsupported"), ("cdp", "ownership")],
)
def test_real_model_tool_fences_each_native_effect_and_retains_claim(
    green, monkeypatch, transition, refusal,
):
    """Public PluginContext + actual registry + real gateway-commissioned lease."""
    from tools.registry import registry

    server, manager, plugins, home = green
    ctx = _reload_granted(manager, plugins, home, monkeypatch)
    monkeypatch.setattr(backend, "TernBrowserCLI", InterleavedOpenCLI)
    peer = Peer()
    attach(server, "s1", peer)
    found = rpc(server, peer, "hermes-tern.browser.blocks", session_id="s1")
    assert found["result"]["available"] is True
    driver = native.get_driver("default", "s1")
    assert driver is not None
    lease = driver.scope.lease
    assert driver.scope.task_id == "durable-s1"
    assert driver.scope.tool_session_id == "tool-s1"
    cli = driver.scope.cli
    assert cli is ActiveCLI.instances[0]
    assert cli.calls == [{"op": "blocks"}]
    selected = registry.get_entry("browser_navigate")
    assert selected is not None
    original_handler = selected.handler
    assert original_handler is backend._NATIVE_HANDLERS["default"]["browser_navigate"]

    def select_handler(handler):
        # Real public registration changes the actual selected registry entry;
        # no synthetic registry or patched readiness result.
        registration = ctx.register_tool(
            name=selected.name, toolset=selected.toolset, schema=selected.schema,
            handler=handler, check_fn=selected.check_fn,
            requires_env=selected.requires_env, is_async=selected.is_async,
            description=selected.description, emoji=selected.emoji, override=True,
        )
        assert registration is not None
        assert registry.get_entry(selected.name).handler is handler

    def replacement(*_args, **_kwargs):
        raise AssertionError("in-flight model may not dispatch another handler")

    if transition == "revoke":
        def change():
            _consent(home, False)
            assert ctx.has_capability("tools.override") is False
    elif transition == "replace":
        def change():
            select_handler(replacement)
    else:
        # The actual Hermes CDP selector reads the live isolated environment.
        monkeypatch.delenv("BROWSER_CDP_URL", raising=False)
        monkeypatch.setattr(backend, "_cdp_selected", _REAL_CDP_SELECTED)
        assert backend._cdp_selected() is False

        def change():
            monkeypatch.setenv("BROWSER_CDP_URL", "http://127.0.0.1:9222")
            assert backend._cdp_selected() is True

    monkeypatch.setattr(InterleavedOpenCLI, "after_open", change)
    result = json.loads(original_handler(
        {"url": "https://example.org/"}, session_id="tool-s1", task_id="durable-s1",
    ))
    assert result["success"] is False and result["error_kind"] == refusal
    assert "no other browser was selected" in result["error"]
    opened = {"op": "open", "owner": 3, "url": "about:blank"}
    # A completed physical open cannot be undone; fence the NEXT invocation.
    assert cli.calls == [{"op": "blocks"}, opened]  # no snapshot/goto/close/fallback
    assert len(ActiveCLI.instances) == 1
    assert native.get_driver("default", "s1") is driver
    assert driver.scope.lease is lease
    assert driver.target is not None and driver.target.block == 10
    assert driver.target.adopted is False
    assert not driver.pending_open and not driver.unknown_open

    if transition == "revoke":
        # Once the original registration unloads its lease never comes back.
        assert manager.unload("hermes-tern")
        assert cli.calls == [{"op": "blocks"}, opened]
        assert native.get_driver("default", "s1") is driver
        assert driver.retired and driver.scope.lease is lease
        assert driver.target.block == 10
        _consent(home, True)
        ctx2 = plugins.PluginContext(plugins.PluginManifest(name="hermes-tern"), manager)
        backend.register(ctx2)
        listing = rpc(server, peer, "hermes-tern.browser.blocks", session_id="s1")
        assert listing["result"] == {
            "available": False, "blocks": [], "reason": "permanently_quarantined",
        }
        denied = rpc(server, peer, "hermes-tern.browser.release",
                     session_id="s1", target_id="10")
        assert denied["error"]["code"] == -32000
        assert cli.calls == [{"op": "blocks"}, opened]
        assert driver.target.block == 10 and driver.scope.lease is lease
    else:
        if transition == "replace":
            assert registry.get_entry("browser_navigate").handler is replacement
            select_handler(original_handler)
        else:
            monkeypatch.delenv("BROWSER_CDP_URL")
            assert backend._cdp_selected() is False
        # No unload here: original selection restored while original lease live.
        released = rpc(
            server, peer, "hermes-tern.browser.release",
            session_id="s1", target_id="10",
        )
        assert released["result"] == {"target_id": "10", "released": True}
        assert cli.calls == [{"op": "blocks"}, opened, {"op": "close", "block": 10}]
        assert native.get_driver("default", "s1") is driver
        assert driver.scope.lease is lease and driver.target is None


class PendingOpenCLI(ActiveCLI):
    """An indeterminate open is reconciled only from its original late reply."""

    def __init__(self, *_args):
        super().__init__(*_args)
        self.late_reply = None
        self.reconcile_attempts = 0

    def __call__(self, op):
        if op["op"] == "open":
            self.calls.append(dict(op))
            raise NativeBrowserError("open_pending")
        return super().__call__(op)

    def reconcile_open(self):
        self.reconcile_attempts += 1
        if self.late_reply is None:
            raise NativeBrowserError("open_pending")
        return self.late_reply


@pytest.mark.parametrize("late_reply", [{"block": 11}, {"not_a_block": "unknown"}])
def test_real_revoked_unload_keeps_late_open_and_unknown_quarantine(
    green, monkeypatch, late_reply,
):
    from tools.registry import registry

    server, manager, plugins, home = green
    _reload_granted(manager, plugins, home, monkeypatch)
    monkeypatch.setattr(backend, "TernBrowserCLI", PendingOpenCLI)
    peer = Peer()
    attach(server, "s1", peer)
    assert rpc(server, peer, "hermes-tern.browser.blocks", session_id="s1")[
        "result"
    ]["available"] is True
    driver = native.get_driver("default", "s1")
    assert driver is not None
    lease = driver.scope.lease
    cli = driver.scope.cli
    handler = registry.get_entry("browser_navigate").handler
    result = json.loads(handler(
        {"url": "https://example.org/"}, session_id="tool-s1", task_id="durable-s1",
    ))
    assert result["error_kind"] == "open_pending"
    opened = {"op": "open", "owner": 3, "url": "about:blank"}
    assert cli.calls == [{"op": "blocks"}, opened]
    assert driver.pending_open and driver.target is None

    _consent(home, False)
    assert manager.unload("hermes-tern")
    assert driver.pending_open and driver.scope.lease is lease
    assert native.get_driver("default", "s1") is driver
    assert cli.reconcile_attempts == 0  # denied before reading the late reply
    assert cli.calls == [{"op": "blocks"}, opened]  # never force cleanup

    _consent(home, True)
    restored = plugins.PluginContext(plugins.PluginManifest(name="hermes-tern"), manager)
    backend.register(restored)
    cli.late_reply = late_reply
    listing = rpc(server, peer, "hermes-tern.browser.blocks", session_id="s1")
    assert listing["result"] == {
        "available": False, "blocks": [], "reason": "permanently_quarantined",
    }
    assert driver.retired and driver.pending_open and driver.target is None
    assert not driver.unknown_open  # no unauthorized late reply reconciliation
    assert cli.reconcile_attempts == 0
    assert cli.calls == [{"op": "blocks"}, opened]
    assert native.get_driver("default", "s1") is driver
    assert driver.scope.lease is lease
    # A new RPC slot for the same durable task cannot discover a substitute.
    replacement = Peer()
    attach(server, "s2", replacement)
    server._sessions["s2"]["session_key"] = "durable-s1"
    before = list(cli.calls)
    no_takeover = rpc(server, replacement, "hermes-tern.browser.blocks", session_id="s2")
    assert no_takeover["result"] == {
        "available": False, "blocks": [], "reason": "permanently_quarantined",
    }
    assert native.get_driver("default", "s2") is None
    assert cli.calls == before


def test_real_create_resume_viewer_and_model_tool_original_driver(green, monkeypatch):
    """Real session factory, viewer API, owner fences and model-tool dispatcher."""
    from tools.registry import registry

    server, manager, plugins, home = green
    _reload_granted(manager, plugins, home, monkeypatch)
    monkeypatch.setattr(tern_env, "pane_env", _REAL_PANE_ENV)
    monkeypatch.setattr(backend, "_viewer", _REAL_VIEWER)
    bin_dir = home / "bin"
    bin_dir.mkdir()
    binary = bin_dir / "tern"
    binary.write_text("#!/bin/sh\nexit 99\n", encoding="utf-8")
    binary.chmod(0o755)
    monkeypatch.setenv("PATH", str(bin_dir) + os.pathsep + os.environ.get("PATH", ""))

    # Construct the real agent against an explicit non-network test provider.
    # No inference request is made; browser routing is the behavior under test.
    monkeypatch.setenv("HERMES_TUI_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "test-browser-routing-not-a-secret")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:1/v1")
    first = Peer()
    created = rpc(server, first, "session.create", rid=401, source="desktop")
    assert "result" in created, created
    sid, durable = created["result"]["session_id"], created["result"]["stored_session_id"]
    assert sid != durable
    assert server._sessions[sid]["session_key"] == durable
    assert server._sessions[sid]["agent_ready"].wait(30)
    agent = server._sessions[sid]["agent"]
    assert agent is not None, server._sessions[sid]
    assert isinstance(agent.session_id, str) and agent.session_id

    pane = {"TERN_PANE": "3", "TERN_WINDOW_KEY": "owned-isolated-window",
            "TERN_DAEMON_SOCKET": "isolated.sock"}
    # The public RPC handler receives its session_id from the gateway context.
    # Claim the durable conversation, not its separate legacy RPC-slot id.
    assert viewers.set_viewer({"pid": os.getpid(), "tern": pane}, session_id=durable) == {"ids": [durable]}
    viewer = viewers.viewer_of([durable])
    assert viewer is not None and viewer.pid == os.getpid() and viewer.tern == pane
    assert viewers.viewer_of([sid]) is None
    assert tern_env.pane_env(durable)["TERN_PANE"] == "3"
    assert tern_env.pane_env(sid) == {}

    second = Peer()
    resumed = rpc(server, second, "session.resume", rid=402, session_id=durable)
    assert "result" in resumed, resumed
    resumed_sid = resumed["result"]["session_id"]
    assert resumed_sid != durable
    assert resumed_sid == sid
    assert server._session_transport_contains(server._sessions[sid], first)
    assert server._session_transport_contains(server._sessions[sid], second)

    listing = rpc(server, second, "hermes-tern.browser.blocks", rid=403, session_id=sid)
    assert listing["result"]["available"], listing
    driver = native.get_driver("default", sid)
    assert driver is not None and driver.scope.lease is not None
    assert driver.scope.rpc_session_id == sid
    assert driver.scope.viewer_session_id == durable
    assert driver.scope.task_id == durable
    assert driver.scope.tool_session_id == agent.session_id
    assert native.get_driver("default", durable) is None
    lease = driver.scope.lease
    before = list(driver.scope.cli.calls)
    for action, opts in (
        ("blocks", {}), ("adopt", {"target_id": "7"}), ("focus", {"target_id": "7"}),
    ):
        result = rpc(server, first, f"hermes-tern.browser.{action}",
                     rid=404, session_id=sid, **opts)
        assert "error" in result, result
        assert result["error"]["code"] == -32000, result
    assert driver.scope.cli.calls == before
    assert driver.scope.lease is lease

    adopted = rpc(server, second, "hermes-tern.browser.adopt",
                  rid=405, session_id=sid, target_id="7")
    assert adopted["result"]["target_id"] == "7", adopted
    focused = rpc(server, second, "hermes-tern.browser.focus",
                  rid=406, session_id=sid, target_id="7")
    assert focused["result"]["target_id"] == "7", focused
    from tools.registry import registry
    selected = registry.get_entry("browser_snapshot")
    assert selected.handler is backend._NATIVE_HANDLERS["default"]["browser_snapshot"]
    tool = json.loads(selected.handler({"full": False},
                        session_id=agent.session_id, task_id=durable))
    assert tool["success"] is True and tool["tern_target"]["target_id"] == "7"
    assert native.get_driver_for_tool("default", agent.session_id, durable) is driver
    assert json.loads(selected.handler({"full": False}, session_id=sid,
                                      task_id=durable))["error_kind"] == "ownership"

    before = list(driver.scope.cli.calls)
    assert viewers.clear_viewer({"pid": os.getpid()}, session_id=durable) == {"ids": [durable]}
    assert viewers.viewer_of([durable]) is None
    assert tern_env.pane_env(durable) == {}
    denied = rpc(server, second, "hermes-tern.browser.focus",
                 rid=407, session_id=sid, target_id="7")
    assert denied["error"]["code"] == -32000, denied
    assert driver.scope.cli.calls == before
    assert driver.scope.lease is lease
