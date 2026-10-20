"""Dictation for the composer: one capture from the microphone, written down by Hermes' own STT.

The frontend (frontend/src/hermes/dictation.ts) runs it in Hermes' interpreter, beside the pane,
when the user presses the record key after `/voice on`:

    $HERMES_PYTHON dictation.py           # one capture
    $HERMES_PYTHON dictation.py --check   # can this machine dictate?

A capture is Hermes' push-to-talk as `voice.record` runs it for the Ink TUI: the VAD-bounded
recorder in ``hermes_cli.voice`` (``voice.silence_threshold``, ``voice.silence_duration``,
``voice.max_recording_seconds``) and the speech-to-text provider in ``stt``. The shared gateway
has no ``voice.record``, and the microphone belongs to the machine the pane runs on, so the
capture runs here.

It writes one JSON object per line: ``{"state": "listening" | "transcribing" | "idle"}``,
``{"partial": text}`` while a streaming provider hears speech, ``{"text": final}`` and
``{"error": message}``. It reads commands, one per line: ``stop`` ends the capture and writes it
down; ``cancel``, or the frontend closing stdin, discards it. It exits once the capture is idle.
``--check`` answers one line: ``{"ready": bool, "details": "..."}``.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path


def _activate() -> None:
    """Hermes' dependencies on the path, as widget_author.py boots them."""
    try:
        from pm.environments import activate_dependencies
    except ImportError:
        return
    activate_dependencies(Path(os.environ.get("HERMES_PYTHON_SRC_ROOT") or "."))


def _number(value, default: float) -> float:
    """A numeric config value, else `default`; a bool is not a number (`silence_threshold: true`)."""
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else default


def _voice_config() -> dict:
    from hermes_cli.config import load_config

    voice = load_config().get("voice")
    return voice if isinstance(voice, dict) else {}


def check() -> dict:
    """What `/voice status` reports: the microphone and the STT provider."""
    from tools.voice_mode import check_voice_requirements

    found = check_voice_requirements()
    return {"ready": bool(found.get("available")), "details": str(found.get("details") or "")}


def capture(write, commands) -> None:
    """One capture: `write` gets each event, `commands` yields the frontend's lines."""
    from hermes_cli import voice

    cfg = _voice_config()
    idle = threading.Event()

    def on_status(state: str) -> None:
        write({"state": state})
        if state == "idle":
            idle.set()

    max_seconds = _number(cfg.get("max_recording_seconds"), 120.0)
    started = voice.start_continuous(
        on_transcript=lambda text: write({"text": text}),
        on_status=on_status,
        # A spoken stop phrase or a silent capture leaves nothing to write down.
        on_silent_limit=lambda: None,
        on_stop_phrase=lambda _text: None,
        on_partial=lambda text: write({"partial": text}),
        silence_threshold=_number(cfg.get("silence_threshold"), 200),
        silence_duration=_number(cfg.get("silence_duration"), 3.0),
        auto_restart=False,
        max_recording_seconds=max_seconds if max_seconds > 0 else 0.0,
    )
    if started is False:
        write({"error": "the microphone is still busy with the last capture"})
        return

    def follow() -> None:
        for line in commands:
            command = line.strip()
            if command == "stop":
                voice.stop_continuous(force_transcribe=True)
            elif command == "cancel":
                break
        # Cancel, or the frontend went away: release the microphone and keep nothing. After a
        # stop this is a no-op, and the transcription in flight finishes on its own.
        voice.stop_continuous()

    threading.Thread(target=follow, name="dictation-commands", daemon=True).start()
    idle.wait()


def main(argv: list[str]) -> None:
    lock = threading.Lock()

    def write(event: dict) -> None:
        with lock:
            print(json.dumps(event), flush=True)

    try:
        _activate()
        if "--check" in argv:
            write(check())
        else:
            capture(write, sys.stdin)
    except ImportError as error:
        write({"error": f"voice input is not installed in this Hermes ({error.name or error})"})
    except Exception as error:  # the frontend shows it and ends the capture
        write({"error": f"{type(error).__name__}: {error}"})


if __name__ == "__main__":
    main(sys.argv[1:])
