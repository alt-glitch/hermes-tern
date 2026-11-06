"""Read the selected profile's Hermes transcript without opening a writable SessionDB.

Schema/encoding: Hermes 22063fc099ec9ad8357d7f8f6e6248a0400680d3,
hermes_state_common.py and hermes_state_messages.py. No core imports or network.
"""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import unicodedata

MAX_CONTENT_BYTES = 16_384
MAX_METADATA_BYTES = 4_096
MAX_CORRECTION_CHARS = 1_024
MAX_SESSIONS = 100
POLICY_VERSION = 1
LOCAL_SOURCES = frozenset({"acp", "cli", "desktop", "gui", "local", "tui"})
_JSON_PREFIX = "\x00json:"
_CORRECTION = re.compile(r"^(?:correction\s*:\s*|actually,\s*|no,\s*)(.+)$", re.I | re.S)
_REQUIRED = {
    "sessions": {"id", "source", "hidden", "parent_session_id", "model_config", "end_reason"},
    "messages": {"id", "session_id", "role", "content", "active", "compacted",
                 "_compressed_summary", "display_kind", "display_metadata"},
}


class SourceError(RuntimeError):
    """The selected profile's source is absent, unreadable, or incompatible."""


def session_scope(session_ids) -> tuple[str, ...]:
    """An explicit bounded selection; never silently broaden to all sessions."""
    if not isinstance(session_ids, (list, tuple)) or not 1 <= len(session_ids) <= MAX_SESSIONS:
        raise ValueError("Select between 1 and 100 session IDs.")
    if any(not isinstance(s, str) or not s or len(s) > 256
           or s != s.strip() or not s.isprintable() for s in session_ids):
        raise ValueError("Session IDs must be nonempty printable strings of at most 256 characters.")
    return tuple(sorted(set(session_ids)))


def rule_key(text: str) -> str:
    return unicodedata.normalize("NFKC", text).casefold()


def tokens(text: str) -> list[str]:
    return re.findall(r"[^\W_]+", rule_key(text))


def _object(raw: bytes | None) -> dict | None:
    if raw is None or raw == b"":
        return {}
    if len(raw) > MAX_METADATA_BYTES:
        return None
    try:
        value = json.loads(raw.decode("utf-8"))
        # Hermes also reads legacy double-encoded display metadata.
        if isinstance(value, str):
            value = json.loads(value)
    except (ValueError, UnicodeError, RecursionError):
        return None
    return value if isinstance(value, dict) else None


def _text(raw: bytes | None) -> str:
    if raw is None or len(raw) > MAX_CONTENT_BYTES:
        return ""
    try:
        value = raw.decode("utf-8")
        if value.startswith(_JSON_PREFIX):
            value = json.loads(value[len(_JSON_PREFIX):])
    except (ValueError, UnicodeError, RecursionError):
        return ""
    # Decode the sentinel only once. JSON-looking plain strings remain literal.
    if isinstance(value, str):
        return value
    parts = value if isinstance(value, list) else [value]
    return "\n".join(p["text"] for p in parts
                     if isinstance(p, dict) and p.get("type") == "text"
                     and isinstance(p.get("text"), str))


def correction(row: sqlite3.Row) -> dict | None:
    """Conservative, extractive distillation of explicitly signalled corrections."""
    if row["source"] not in LOCAL_SOURCES or row["hidden"] != 0:
        return None
    if not (row["active"] == 1 or row["compacted"] == 1) or row["_compressed_summary"] != 0:
        return None
    if row["display_kind"] not in (None, "", "steer"):
        return None
    config, metadata = _object(row["model_config"]), _object(row["display_metadata"])
    if config is None or metadata is None or config.get("_delegate_from"):
        return None
    if metadata.get("model_only") or metadata.get("_queued_prompt"):
        return None
    parent = row["parent_session_id"]
    if parent and not (config.get("_branched_from") == parent
                       or config.get("_reset_from") == parent
                       or row["parent_end_reason"] == "compression"):
        return None
    text = _text(row["content"]).strip()
    match = _CORRECTION.match(text)
    if not match:
        return None
    # Preserve complete wording and qualifications; never truncate a rule.
    text = " ".join(match.group(1).split())
    if not text or len(text) > MAX_CORRECTION_CHARS or not tokens(text):
        return None
    if any(unicodedata.category(c).startswith("C") for c in text):
        return None
    return {"message_id": row["id"], "session_id": row["session_id"], "text": text}


class Snapshot:
    def __init__(self, connection: sqlite3.Connection, scope: tuple[str, ...]):
        self.connection = connection
        self.scope = scope
        placeholders = ",".join("?" for _ in scope)
        # BLOB bounds matter: SQLite TEXT length/substr stop at the sentinel's NUL.
        self.query = f"""
            SELECT m.id, m.session_id, m.active, m.compacted, m._compressed_summary,
                   m.display_kind,
                   substr(CAST(m.content AS BLOB), 1, {MAX_CONTENT_BYTES + 1}) AS content,
                   substr(CAST(m.display_metadata AS BLOB), 1, {MAX_METADATA_BYTES + 1})
                       AS display_metadata,
                   s.source, s.hidden, s.parent_session_id,
                   substr(CAST(s.model_config AS BLOB), 1, {MAX_METADATA_BYTES + 1}) AS model_config,
                   p.end_reason AS parent_end_reason
            FROM messages m JOIN sessions s ON s.id = m.session_id
            LEFT JOIN sessions p ON p.id = s.parent_session_id
            WHERE s.id IN ({placeholders}) AND m.role = 'user'
        """

    def fingerprint(self) -> str:
        """O(N), bounded-memory revision of every field that can change extraction."""
        digest = hashlib.sha256(json.dumps(
            [POLICY_VERSION, self.scope], ensure_ascii=True, separators=(",", ":")).encode("ascii"))
        cursor = self.connection.execute(self.query + " ORDER BY m.id", self.scope)
        try:
            for row in cursor:
                values = [v.hex() if isinstance(v, bytes) else v for v in row]
                digest.update(json.dumps(values, ensure_ascii=True, separators=(",", ":")).encode("ascii"))
                digest.update(b"\n")
        finally:
            cursor.close()
        return digest.hexdigest()

    def batch(self, after: int, size: int) -> list[sqlite3.Row]:
        # One lookahead row proves completion even when the last batch is exactly full.
        cursor = self.connection.execute(
            self.query + " AND m.id > ? ORDER BY m.id LIMIT ?", (*self.scope, after, size + 1))
        try:
            return cursor.fetchall()
        finally:
            cursor.close()


@contextmanager
def snapshot(path: Path, scope: tuple[str, ...]):
    connection = None
    try:
        # URI quoting preserves profile paths containing '?' or '#'. Never immutable:
        # a live Hermes profile can have committed rows in its WAL.
        connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only = ON")
        connection.execute("BEGIN")
        for table, required in _REQUIRED.items():
            columns = {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}
            if not required <= columns:
                raise SourceError(f"Incompatible Hermes {table} schema; no source migration was attempted.")
        yield Snapshot(connection, scope)
    except sqlite3.Error as error:
        raise SourceError("Cannot read the selected profile's Hermes state.db.") from error
    finally:
        if connection is not None:
            connection.close()
