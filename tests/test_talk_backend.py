"""No device/network use: exercise actual controller threads and cancellation."""
import asyncio
import contextvars
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from hermes_tern_plugin.talk_backend import TalkController, Call, ObservedSession


def invoke(controller, action, id="call-1", owner="session-1"):
    return json.loads(controller.command(action + " " + id, session_key=owner))


def test_start_is_single_owner_idempotent_and_stop_waits_for_cleanup():
    entered, cleaned = threading.Event(), threading.Event()
    async def runner(call):
        entered.set()
        call.phase = "listening"
        try:
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(0.02)
            cleaned.set()
    controller = TalkController(runner)
    try:
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: invoke(controller, "start"), range(8)))
        assert entered.wait(1)
        assert all(x["active"] for x in results)
        with pytest.raises(PermissionError):
            invoke(controller, "start", "other")
        with pytest.raises(PermissionError):
            invoke(controller, "stop", owner="foreign")
        assert invoke(controller, "stop")["active"] is False
        assert cleaned.is_set()
        assert invoke(controller, "status")["phase"] == "idle"
    finally:
        controller.close()


def test_lost_frontend_heartbeat_cancels_call_and_releases_owner():
    cleaned = threading.Event()
    async def runner(call):
        try:
            await asyncio.Event().wait()
        finally:
            cleaned.set()
    controller = TalkController(runner, heartbeat_timeout=0.04)
    invoke(controller, "start")
    assert cleaned.wait(1)
    assert controller.call.done.wait(1)
    assert invoke(controller, "status")["active"] is False


def test_stop_during_start_preserves_context_and_cannot_reopen():
    context = contextvars.ContextVar("profile", default="wrong")
    context.set("right")
    seen = []
    async def runner(call):
        seen.append(context.get())
        await asyncio.Event().wait()
    controller = TalkController(runner)
    invoke(controller, "start")
    assert invoke(controller, "stop")["active"] is False
    assert seen in ([], ["right"])
    assert controller.call.done.is_set()


def test_failure_redacts_raw_provider_exception():
    async def runner(call):
        raise ValueError("secret-token-should-not-leak")
    controller = TalkController(runner)
    invoke(controller, "start")
    assert controller.call.done.wait(1)
    receipt = invoke(controller, "status")
    assert not receipt["active"] and "ValueError" in receipt["error"]
    assert "secret-token" not in json.dumps(receipt)


def test_status_without_call_never_starts_a_worker():
    controller = TalkController(lambda call: pytest.fail("unexpected capture"))
    assert invoke(controller, "status")["active"] is False
    assert invoke(controller, "stop")["active"] is False
    with pytest.raises(PermissionError):
        controller.command("start call-1")
    assert controller.call is None


def test_phase_observer_preserves_actual_provider_events_and_teardown():
    events = [type(name, (), {})() for name in ["SpeechStarted", "SpeechStopped", "ResponseStarted", "OutputAudio", "ResponseFinished"]]
    class Provider:
        async def connect(self, setup): pass
        async def close(self): self.closed = True
        async def send(self, commands): return commands
        async def __aiter__(self):
            for event in events: yield event
    async def run():
        call = Call("session", "call")
        provider = Provider()
        session = ObservedSession(provider, call)
        await session.connect(None)
        assert call.phase == "listening"
        seen, phases = [], []
        async for event in session:
            seen.append(event)
            phases.append(call.phase)
        assert seen == events
        assert phases == ["listening", "thinking", "thinking", "speaking", "listening"]
        await session.close()
        assert provider.closed
    asyncio.run(run())
