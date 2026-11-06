"""One atomic checkpoint for records and their scan cursor, serialized across panes."""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import tempfile
import unicodedata

from .source import MAX_CORRECTION_CHARS, rule_key, session_scope, tokens

STATE_VERSION = 1
MAX_CORRECTIONS = 4_096
MAX_STATE_BYTES = 32 * 1024 * 1024
_KEYS = {"version", "sessions", "source_digest", "cursor", "complete", "limited", "records"}


class StateVersionError(RuntimeError):
    """A newer checkpoint must not be overwritten by an older implementation."""


def _canonical(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                      allow_nan=False).encode("utf-8")


def _valid(state) -> bool:
    if not isinstance(state, dict) or set(state) != _KEYS:
        return False
    if type(state["version"]) is not int or state["version"] != STATE_VERSION:
        return False
    try:
        if list(session_scope(state["sessions"])) != state["sessions"]:
            return False
    except ValueError:
        return False
    if not isinstance(state["source_digest"], str) or not re.fullmatch(r"[0-9a-f]{64}", state["source_digest"]):
        return False
    if type(state["cursor"]) is not int or state["cursor"] < 0:
        return False
    if type(state["complete"]) is not bool or type(state["limited"]) is not bool:
        return False
    records = state["records"]
    if not isinstance(records, list) or len(records) > MAX_CORRECTIONS:
        return False
    seen, last_id = set(), 0
    for record in records:
        if not isinstance(record, dict) or set(record) != {"message_id", "session_id", "text"}:
            return False
        mid, sid, text = record["message_id"], record["session_id"], record["text"]
        if type(mid) is not int or not last_id < mid <= state["cursor"] or sid not in state["sessions"]:
            return False
        if (not isinstance(text, str) or not 1 <= len(text) <= MAX_CORRECTION_CHARS
                or text != " ".join(text.split()) or not tokens(text)
                or any(unicodedata.category(c).startswith("C") for c in text)):
            return False
        key = rule_key(text)
        if key in seen:
            return False
        seen.add(key)
        last_id = mid
    return True


class StateStore:
    def __init__(self, directory: Path):
        self.directory = directory
        self.path = directory / "memory.json"
        self.backup = directory / "memory.json.bak"

    @contextmanager
    def locked(self):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(self.directory / ".memory.lock", os.O_CREAT | os.O_RDWR, 0o600)
        with os.fdopen(fd, "r+b") as handle:
            if os.name == "nt":
                import msvcrt

                handle.seek(0, os.SEEK_END)
                if handle.tell() == 0:
                    handle.write(b"\0")
                    handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
                try:
                    yield
                finally:
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def _read(self, path: Path) -> dict | None:
        try:
            with path.open("rb") as handle:
                raw = handle.read(MAX_STATE_BYTES + 1)
        except FileNotFoundError:
            return None
        if len(raw) > MAX_STATE_BYTES:
            return None
        try:
            envelope = json.loads(raw)
            state = envelope.get("state") if isinstance(envelope, dict) else None
            if isinstance(state, dict) and type(state.get("version")) is int:
                if state["version"] != STATE_VERSION:
                    raise StateVersionError("Unsupported Glide memory version; checkpoint preserved.")
            if (not isinstance(envelope, dict) or set(envelope) != {"sha256", "state"}
                    or not isinstance(envelope["sha256"], str) or not _valid(state)):
                return None
            digest = hashlib.sha256(_canonical(state)).hexdigest()
            return state if hmac.compare_digest(digest, envelope["sha256"]) else None
        except (ValueError, UnicodeError, TypeError, RecursionError):
            return None

    def load(self) -> tuple[dict | None, bool]:
        primary = self._read(self.path)
        if primary is not None:
            return primary, False
        backup = self._read(self.backup)
        recovered = backup is not None or self.path.exists() or self.backup.exists()
        return backup, recovered

    def _atomic(self, path: Path, raw: bytes) -> None:
        fd, name = tempfile.mkstemp(dir=self.directory, prefix=".memory-", suffix=".tmp")
        try:
            # mkstemp creates a private (0600) file; replacement preserves that mode.
            with os.fdopen(fd, "wb") as handle:
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(name, path)
            if os.name != "nt":
                folder_fd = os.open(self.directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
                try:
                    os.fsync(folder_fd)
                finally:
                    os.close(folder_fd)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    @staticmethod
    def _encode(state: dict) -> bytes:
        if not _valid(state):
            raise ValueError("Refusing an invalid Glide memory checkpoint.")
        raw = _canonical({"sha256": hashlib.sha256(_canonical(state)).hexdigest(), "state": state})
        if len(raw) > MAX_STATE_BYTES:
            raise ValueError("Glide memory checkpoint exceeds its size limit.")
        return raw

    def save(self, state: dict) -> None:
        """Call under locked(); a corrupt primary never replaces a good backup."""
        raw = self._encode(state)
        previous = self._read(self.path)
        if previous is not None:
            self._atomic(self.backup, self._encode(previous))
        self._atomic(self.path, raw)
