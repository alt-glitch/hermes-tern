"""Read the selected profile's Hermes transcript without opening a writable SessionDB.

Schema/encoding: Hermes 22063fc099ec9ad8357d7f8f6e6248a0400680d3,
hermes_state_common.py and hermes_state_messages.py. No core imports or network.
"""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import unicodedata

MAX_CONTENT_BYTES = 16_384
MAX_METADATA_BYTES = 4_096
MAX_ABSORBED_UIDS = 128
MAX_CORRECTION_CHARS = 1_024
MAX_SESSIONS = 100
POLICY_VERSION = 3
LOCAL_SOURCES = frozenset({"acp", "cli", "desktop", "gui", "local", "tui"})
_JSON_PREFIX = "\x00json:"
_CORRECTION = re.compile(r"^(?:correction\s*:\s*|actually,\s*|no,\s*)(.+)$", re.I | re.S)
_REQUIRED = {
    "sessions": {"id", "source", "hidden", "parent_session_id", "model_config", "end_reason"},
    "messages": {"id", "session_id", "role", "content", "timestamp", "active", "compacted",
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


def _absorbed_uids(raw: bytes | None) -> tuple[bytes, ...]:
    """Read the complete bounded merge witness; truncation cannot hide a withdrawal."""
    if raw is None or raw == b"":
        return ()
    try:
        if len(raw) > MAX_METADATA_BYTES:
            raise ValueError("oversized witness")
        value = json.loads(raw.decode("utf-8"))
        if (not isinstance(value, list) or len(value) > MAX_ABSORBED_UIDS
                or any(not isinstance(uid, str) or not uid for uid in value)):
            raise ValueError("invalid witness")
        uids = tuple(dict.fromkeys(uid.encode("utf-8") for uid in value))
        if any(len(uid) > MAX_METADATA_BYTES for uid in uids):
            raise ValueError("oversized identity")
        return uids
    except (ValueError, UnicodeError, RecursionError) as error:
        raise SourceError("Cannot resolve malformed or oversized Hermes absorbed-message identities.") from error


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


def _session_config(row: sqlite3.Row) -> dict | None:
    if row["source"] not in LOCAL_SOURCES or row["hidden"] != 0:
        return None
    config = _object(row["model_config"])
    if config is None or config.get("_delegate_from"):
        return None
    parent = row["parent_session_id"]
    if parent and not (config.get("_branched_from") == parent
                       or config.get("_reset_from") == parent
                       or row["parent_end_reason"] == "compression"):
        return None
    return config


def correction(row: sqlite3.Row) -> dict | None:
    """Conservative extraction after Snapshot has resolved logical generations."""
    if _session_config(row) is None:
        return None
    if not (row["active"] == 1 or row["compacted"] == 1) or row["_compressed_summary"] != 0:
        return None
    if row["display_kind"] not in (None, "", "steer"):
        return None
    # Never turn a truncated durable UID into a legacy content identity.
    if row["message_uid"] is not None and len(row["message_uid"]) > MAX_METADATA_BYTES:
        return None
    metadata = _object(row["display_metadata"])
    if metadata is None or metadata.get("model_only") or metadata.get("_queued_prompt"):
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
    def __init__(self, connection: sqlite3.Connection, scope: tuple[str, ...],
                 message_columns: set[str]):
        self.connection = connection
        self.scope = scope
        self._sessions = {}
        self._session_query = f"""
            SELECT s.id, s.source, s.hidden, s.parent_session_id,
                   substr(CAST(s.model_config AS BLOB), 1, {MAX_METADATA_BYTES + 1}) AS model_config,
                   p.end_reason AS parent_end_reason
            FROM sessions s LEFT JOIN sessions p ON p.id = s.parent_session_id
            WHERE s.id = ?
        """
        # Only ancestry metadata is traversed; message content remains explicitly scoped.
        paths = {sid: self._lineage_path(sid) for sid in scope}
        self.lineages = {sid: path[-1] for sid, path in paths.items()}
        self.lineage_paths = sorted(paths.items())
        for sid, path in paths.items():
            for other, other_path in paths.items():
                if (path[-1] == other_path[-1] and sid not in other_path and other not in path):
                    raise SourceError("Select only one continuation per Hermes compression lineage.")
        connection.create_function("glide_uid_identity", 3, self._uid_identity, deterministic=True)
        connection.create_function("glide_legacy_identity", 7, self._legacy_identity,
                                   deterministic=True)
        connection.create_function("glide_absorbed_identities", 3, self._absorbed_identities,
                                   deterministic=True)
        self._batch_cursor = None
        self._batch_after = None
        self._lookahead = []
        placeholders = ",".join("?" for _ in scope)
        # Older databases can predate UIDs. Legacy identity uses exact stored payload,
        # timestamp and tool fields, never normalized correction wording.
        identity_fields = ", ".join(
            f"substr(CAST(m.{field} AS BLOB), 1, {limit + 1}) AS {field}"
            if field in message_columns else f"NULL AS {field}"
            for field, limit in (("message_uid", MAX_METADATA_BYTES),
                                 ("absorbed_message_uids", MAX_METADATA_BYTES),
                                 ("tool_call_id", MAX_METADATA_BYTES),
                                 ("tool_calls", MAX_CONTENT_BYTES),
                                 ("tool_name", MAX_METADATA_BYTES)))
        # BLOB bounds matter: SQLite TEXT length/substr stop at the sentinel's NUL.
        self.query = f"""
            SELECT m.id, m.session_id, m.active, m.compacted, m._compressed_summary,
                   m.display_kind, m.timestamp, {identity_fields},
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

    def _session(self, sid: str):
        if sid not in self._sessions:
            cursor = self.connection.execute(self._session_query, (sid,))
            try:
                self._sessions[sid] = cursor.fetchone()
            finally:
                cursor.close()
        return self._sessions[sid]

    def _lineage_path(self, sid: str) -> tuple[str, ...]:
        current, seen, path = sid, set(), []
        for _ in range(MAX_SESSIONS):
            if current in seen:
                raise SourceError("Cannot resolve a cyclic Hermes compression lineage.")
            seen.add(current)
            path.append(current)
            row = self._session(current)
            config = _session_config(row) if row is not None else None
            if config is None:
                return tuple(path)
            parent = row["parent_session_id"]
            # Markers copied from an older ancestor do not make this hop a fork.
            if (not parent or row["parent_end_reason"] != "compression"
                    or any(config.get(key) == parent
                           for key in ("_branched_from", "_reset_from", "_delegate_from"))):
                return tuple(path)
            parent_row = self._session(parent)
            if parent_row is None or _session_config(parent_row) is None:
                return tuple(path)
            current = parent
        raise SourceError("Hermes compression lineage exceeds the supported 100-session bound.")

    @staticmethod
    def _identity_key(parts) -> str:
        raw = json.dumps(parts, ensure_ascii=True, separators=(",", ":")).encode("ascii")
        return hashlib.sha256(raw).hexdigest()

    def _uid_identity(self, mid, sid, uid):
        if not uid:
            return None
        if len(uid) > MAX_METADATA_BYTES:
            # Invalid identities stay isolated and correction() omits their rows.
            return self._identity_key([sid, "row", mid])
        return self._identity_key([self.lineages[sid], "uid", uid.hex()])

    def _absorbed_identities(self, mid, sid, raw):
        row = self._session(sid)
        if row is None or _session_config(row) is None:
            return "[]"
        return json.dumps([self._uid_identity(mid, sid, uid) for uid in _absorbed_uids(raw)])

    def _legacy_identity(self, mid, sid, timestamp, content, call_id, calls, tool_name):
        fields = (content, call_id, calls, tool_name)
        limits = (MAX_CONTENT_BYTES, MAX_METADATA_BYTES, MAX_CONTENT_BYTES, MAX_METADATA_BYTES)
        if (isinstance(timestamp, (int, float)) and math.isfinite(timestamp)
                and all(value is None or len(value) <= limit for value, limit in zip(fields, limits))):
            return self._identity_key([
                self.lineages[sid], "legacy", timestamp,
                *[value.hex() if value is not None else None for value in fields]])
        return self._identity_key([sid, "row", mid])

    def fingerprint(self) -> str:
        """Stream all generations, including withdrawals and identity/lineage changes."""
        digest = hashlib.sha256(json.dumps(
            [POLICY_VERSION, self.scope, self.lineage_paths],
            ensure_ascii=True, separators=(",", ":")).encode("ascii"))
        cursor = self.connection.execute(self.query + " ORDER BY m.id", self.scope)
        try:
            for row in cursor:
                # Validate even on a completed checkpoint: silently dropping an invalid
                # witness could serve a constituent that a composite withdrew.
                if _session_config(row) is not None:
                    _absorbed_uids(row["absorbed_message_uids"])
                values = [v.hex() if isinstance(v, bytes) else v for v in row]
                digest.update(json.dumps(values, ensure_ascii=True, separators=(",", ":")).encode("ascii"))
                digest.update(b"\n")
        finally:
            cursor.close()
        return digest.hexdigest()

    def batch(self, after: int, size: int) -> list[sqlite3.Row]:
        # Resolve the newest physical generation BEFORE visibility/extraction or the
        # resume cursor. A withdrawn copy must shadow even an active ancestor. Older
        # (0, 0) originals from normal compaction must not shadow their newer live copy.
        if self._batch_cursor is None or after != self._batch_after:
            self.close()
            self._batch_cursor = self.connection.execute(f"""
                WITH selected AS ({self.query}),
                identities AS (
                    SELECT selected.*,
                           glide_uid_identity(id, session_id, message_uid) AS uid_key,
                           glide_legacy_identity(
                               id, session_id, timestamp, content,
                               tool_call_id, tool_calls, tool_name) AS legacy_key
                    FROM selected
                ),
                legacy_uids AS (
                    SELECT legacy_key, COUNT(DISTINCT uid_key) AS uid_count,
                           MAX(uid_key) AS only_uid
                    FROM identities GROUP BY legacy_key
                ),
                resolved AS (
                    SELECT i.*, u.uid_count, COALESCE(i.uid_key,
                        CASE WHEN u.uid_count = 1 THEN u.only_uid ELSE i.legacy_key END
                    ) AS identity_key
                    FROM identities i JOIN legacy_uids u ON u.legacy_key = i.legacy_key
                ),
                ranked AS (
                    SELECT resolved.*, ROW_NUMBER() OVER (
                        PARTITION BY identity_key ORDER BY id DESC
                    ) AS generation
                    FROM resolved
                ),
                witnesses AS (
                    SELECT id, identity_key, active, compacted FROM resolved
                    UNION ALL
                    SELECT i.id, absorbed.value, i.active, i.compacted
                    FROM identities i, json_each(glide_absorbed_identities(
                        i.id, i.session_id, i.absorbed_message_uids)) AS absorbed
                ),
                latest_witnesses AS (
                    SELECT witnesses.*, ROW_NUMBER() OVER (
                        PARTITION BY identity_key ORDER BY id DESC
                    ) AS witness_generation
                    FROM witnesses
                )
                SELECT r.* FROM ranked r JOIN latest_witnesses w
                    ON w.identity_key = r.identity_key AND w.witness_generation = 1
                WHERE r.generation = 1 AND (r.uid_key IS NOT NULL OR r.uid_count <= 1)
                      AND (w.id = r.id OR w.active = 1 OR w.compacted = 1)
                      AND r.id > ? ORDER BY r.id
            """, (*self.scope, after))
            self._lookahead = []
        # A composite supplies state for every constituent, not replacement text:
        # an ordinary leading turn may hide a correction from prefix extraction.
        # Newer live witnesses override older composite withdrawals without merging
        # distinct UIDs; a withdrawal only suppresses older constituent generations.
        # A legacy row can adopt its unique exact-match UID; ambiguous legacy rows
        # are omitted rather than reviving a potentially withdrawn instruction.
        # Keep one streaming cursor so SQLite ranks once per sync, not once per batch.
        rows = self._lookahead + self._batch_cursor.fetchmany(size + 1 - len(self._lookahead))
        self._lookahead = rows[size:]
        self._batch_after = rows[min(size, len(rows)) - 1]["id"] if rows else after
        return rows

    def close(self) -> None:
        if self._batch_cursor is not None:
            self._batch_cursor.close()
            self._batch_cursor = None


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
        schemas = {}
        for table, required in _REQUIRED.items():
            columns = {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}
            schemas[table] = columns
            if not required <= columns:
                raise SourceError(f"Incompatible Hermes {table} schema; no source migration was attempted.")
        view = Snapshot(connection, scope, schemas["messages"])
        try:
            yield view
        finally:
            view.close()
    except sqlite3.Error as error:
        raise SourceError("Cannot read the selected profile's Hermes state.db.") from error
    finally:
        if connection is not None:
            connection.close()
