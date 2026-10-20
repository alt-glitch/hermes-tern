"""dictation.py without Hermes or a microphone: hermes_cli.voice and the config are stubbed."""

import io
import json
import runpy
import sys
import types
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "dictation.py"


class FakeVoice:
    """hermes_cli.voice's continuous capture, driven by the test instead of a microphone."""

    def __init__(self, *, heard="hello world", vad_stops=False, busy=False, fails=None):
        self.heard, self.vad_stops, self.busy, self.fails = heard, vad_stops, busy, fails
        self.active = False
        self.started = {}
        self.stops = []

    def start_continuous(self, **kwargs):
        if self.fails:
            raise self.fails
        if self.busy:
            return False
        self.started = kwargs
        self.active = True
        kwargs["on_status"]("listening")
        kwargs["on_partial"]("hello")
        if self.vad_stops:  # silence ended the capture before any command came
            self._finish(transcribe=True)
        return True

    def stop_continuous(self, force_transcribe=False):
        self.stops.append(force_transcribe)
        if self.active:
            self._finish(transcribe=force_transcribe)

    def _finish(self, *, transcribe):
        self.active = False
        on_status = self.started["on_status"]
        if transcribe:
            on_status("transcribing")
            if self.heard:
                self.started["on_transcript"](self.heard)
        on_status("idle")


@pytest.fixture()
def run(monkeypatch, capsys):
    """Runs the script with `stdin` as the frontend's commands; returns its JSON lines."""

    def go(voice, stdin="", argv=(), config=None, requirements=None):
        hermes_cli = types.ModuleType("hermes_cli")
        hermes_cli.voice = voice
        cfg = types.ModuleType("hermes_cli.config")
        cfg.load_config = lambda: config if config is not None else {}
        tools = types.ModuleType("tools")
        voice_mode = types.ModuleType("tools.voice_mode")
        voice_mode.check_voice_requirements = lambda: requirements or {}
        monkeypatch.setitem(sys.modules, "hermes_cli", hermes_cli)
        monkeypatch.setitem(sys.modules, "hermes_cli.voice", voice)
        monkeypatch.setitem(sys.modules, "hermes_cli.config", cfg)
        monkeypatch.setitem(sys.modules, "tools", tools)
        monkeypatch.setitem(sys.modules, "tools.voice_mode", voice_mode)
        monkeypatch.setattr(sys, "stdin", io.StringIO(stdin))
        monkeypatch.setattr(sys, "argv", [str(SCRIPT), *argv])
        runpy.run_path(str(SCRIPT), run_name="__main__")
        return [json.loads(line) for line in capsys.readouterr().out.splitlines()]

    return go


def test_stop_writes_the_capture_down_with_the_voice_config(run):
    voice = FakeVoice()
    config = {"voice": {"silence_threshold": 350, "silence_duration": True, "max_recording_seconds": 0}}
    assert run(voice, "stop\n", config=config) == [
        {"state": "listening"},
        {"partial": "hello"},
        {"state": "transcribing"},
        {"text": "hello world"},
        {"state": "idle"},
    ]
    assert voice.stops[0] is True
    assert voice.started["auto_restart"] is False
    assert voice.started["silence_threshold"] == 350
    assert voice.started["silence_duration"] == 3.0  # a bool is not a duration
    assert voice.started["max_recording_seconds"] == 0.0  # 0 turns the cap off, as in voice.record


def test_cancel_and_a_closed_stdin_discard_the_capture(run):
    for stdin in ("cancel\nstop\n", ""):
        voice = FakeVoice()
        lines = run(voice, stdin)
        assert lines == [{"state": "listening"}, {"partial": "hello"}, {"state": "idle"}]
        assert voice.stops == [False]


def test_silence_ends_the_capture_by_itself(run):
    voice = FakeVoice(vad_stops=True)
    assert run(voice, "")[-2:] == [{"text": "hello world"}, {"state": "idle"}]
    assert True not in voice.stops


def test_a_busy_microphone_and_a_failed_start_are_errors(run):
    assert run(FakeVoice(busy=True)) == [{"error": "the microphone is still busy with the last capture"}]
    assert run(FakeVoice(fails=OSError("no input device"))) == [{"error": "OSError: no input device"}]


def test_check_reports_what_voice_status_does(run):
    requirements = {"available": False, "details": "Audio capture: OK\nSTT provider: MISSING"}
    assert run(FakeVoice(), argv=["--check"], requirements=requirements) == [
        {"ready": False, "details": "Audio capture: OK\nSTT provider: MISSING"}
    ]
