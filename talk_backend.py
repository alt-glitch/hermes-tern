"""Cancellable, single-owner Hermes Talk calls behind a short plugin command.

No new model tools or private gateway RPCs. Provider/auth/tool policy stays in
hermes-talk; this adapter owns the task and reports provider-observed phases.
"""
from __future__ import annotations

import asyncio
import contextvars
import gc
import importlib
import json
import threading
import time
from dataclasses import dataclass, field

HEARTBEAT_TIMEOUT = 8.0
STOP_TIMEOUT = 4.0


@dataclass
class Call:
    owner: str
    id: str
    phase: str = "starting"
    error: str = ""
    touched: float = field(default_factory=time.monotonic)
    stopping: bool = False
    done: threading.Event = field(default_factory=threading.Event)
    loop: asyncio.AbstractEventLoop | None = None
    task: asyncio.Task | None = None
    audio: object = None

    def cancel(self):
        self.stopping = True
        self.phase = "stopping"
        if self.loop is not None and self.task is not None:
            self.loop.call_soon_threadsafe(self.task.cancel)

    def snapshot(self):
        phase = self.phase
        if not self.stopping and self.audio is not None and getattr(self.audio, "playback_pending", False):
            phase = "speaking"
        return {"live_id": self.id, "phase": phase, "active": not self.done.is_set(), "error": self.error}


class ObservedSession:
    def __init__(self, inner, call):
        self.inner, self.call = inner, call

    async def connect(self, setup):
        await self.inner.connect(setup)
        if not self.call.stopping:
            self.call.phase = "listening"

    async def send(self, commands):
        return await self.inner.send(commands)

    async def close(self):
        return await self.inner.close()

    def __getattr__(self, name):
        return getattr(self.inner, name)

    async def __aiter__(self):
        phases = {"SpeechStarted": "listening", "SpeechStopped": "thinking",
                  "ResponseStarted": "thinking", "OutputAudio": "speaking",
                  "OutputInterrupted": "listening", "FunctionCall": "thinking",
                  "ResponseFinished": "listening"}
        async for event in self.inner:
            if not self.call.stopping:
                phase = phases.get(type(event).__name__)
                if phase:
                    self.call.phase = phase
            yield event


def _talk_module():
    from hermes_cli.plugins import get_plugin_command_handler
    handler = get_plugin_command_handler("talk")
    if handler is None:
        raise RuntimeError("Install and enable hermes-talk in this profile first.")
    module = importlib.import_module(handler.__module__)
    cli = getattr(module, "talk_cli", None)
    if cli is None or not callable(getattr(cli, "run_talk_session", None)):
        raise RuntimeError("This hermes-talk build does not expose the supported terminal session adapter.")
    return cli


async def _run(call):
    cli = _talk_module()
    # Do not start alongside a /talk call outside this controller.
    for obj in gc.get_objects():
        if not isinstance(obj, asyncio.Task) or obj.done():
            continue
        code = getattr(obj.get_coro(), "cr_code", None)
        if code is not None and code.co_name == "run_talk_session" and code.co_filename == cli.__file__:
            raise RuntimeError("Another Hermes Talk call is active. End it before starting this one.")
    # Let Talk acquire and clean up audio itself (including cancellation during setup).
    # A session proxy observes provider lifecycle without replacing its tool policy.
    # Construction does not acquire a device. Talk starts it after its own preflight.
    call.audio = cli.talk_audio.DuplexAudio()
    try:
        result = await cli.run_talk_session(
            audio=call.audio,
            session_factory=lambda auth: ObservedSession(cli._realtime_session(auth), call),
            keyboard_control=False,
            on_refusal=lambda reason: setattr(call, "error", "Hermes Talk refused startup: " + str(reason)),
        )
        if result:
            raise RuntimeError(call.error or "Hermes Talk ended with an error; check its provider/audio diagnostics.")
    finally:
        # Belt for cancellation/refusal before Talk reaches its own teardown block.
        call.audio.stop()


class TalkController:
    def __init__(self, runner=_run, heartbeat_timeout=HEARTBEAT_TIMEOUT):
        self.runner = runner
        self.heartbeat_timeout = heartbeat_timeout
        self.lock = threading.Lock()
        self.call = None

    def command(self, raw="", *, session_key="", session_id="", **_):
        parts = raw.split()
        if len(parts) != 2 or parts[0] not in {"start", "status", "stop"}:
            raise ValueError("Usage: /tern-talk start|status|stop CALL_ID")
        action, live_id = parts
        if not live_id or len(live_id) > 128 or not all(c.isalnum() or c in "-_" for c in live_id):
            raise ValueError("Invalid voice call identity")
        owner = session_key or session_id
        if not owner:
            raise PermissionError("Voice requires an attached Hermes session.")
        with self.lock:
            call = self.call
            if call is not None and not call.done.is_set():
                if (call.owner, call.id) != (owner, live_id):
                    raise PermissionError("A different conversation already owns the microphone.")
                call.touched = time.monotonic()
            elif action == "start":
                call = Call(owner, live_id)
                self.call = call
                context = contextvars.copy_context()
                threading.Thread(target=lambda: context.run(self._worker, call),
                                 daemon=True, name="hermes-tern-talk").start()
            elif call is None or (call.owner, call.id) != (owner, live_id):
                return json.dumps({"live_id": live_id, "phase": "idle", "active": False, "error": ""})
            if action == "stop" and not call.done.is_set():
                call.cancel()
        if action == "stop":
            call.done.wait(STOP_TIMEOUT)
        return json.dumps(call.snapshot())

    def _worker(self, call):
        async def main():
            call.loop = asyncio.get_running_loop()
            if call.stopping:
                return
            call.task = asyncio.create_task(self.runner(call))
            if call.stopping:
                call.task.cancel()
            async def watchdog():
                while not call.task.done():
                    await asyncio.sleep(min(0.5, self.heartbeat_timeout / 2))
                    if time.monotonic() - call.touched > self.heartbeat_timeout:
                        call.cancel()
            watch = asyncio.create_task(watchdog())
            try:
                await call.task
            finally:
                watch.cancel()
                await asyncio.gather(watch, return_exceptions=True)
        try:
            asyncio.run(main())
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            # Never serialize provider exceptions, which can contain endpoint credentials.
            call.error = str(exc) if isinstance(exc, RuntimeError) and str(exc).startswith(("Install ", "This hermes-talk", "Another Hermes", "Hermes Talk")) else "Voice session failed (" + type(exc).__name__ + ")."
        finally:
            call.phase = "idle"
            call.audio = None
            call.done.set()

    def close(self):
        with self.lock:
            call = self.call
            if call and not call.done.is_set():
                call.cancel()
        if call:
            call.done.wait(STOP_TIMEOUT)


_controller = TalkController()


def register(ctx):
    ctx.register_command("tern-talk", handler=_controller.command,
                         description="Owned Hermes Talk call: start, status, stop",
                         args_hint="start|status|stop CALL_ID")
    if callable(getattr(ctx, "on_unload", None)):
        ctx.on_unload(_controller.close)
