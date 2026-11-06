"""Regression through Hermes' real persistence, compression and rewind APIs.

Requires the existing pinned Hermes core test environment. All transcript text is
synthetic workflow data; the standalone SQLite fixtures remain in test_glide_memory.py.
"""

import json
import socket
import subprocess

import pytest

from hermes_tern_plugin.glide import GlideMemory, MemoryNotReady


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Glide memory must remain local.")
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(socket, "getaddrinfo", forbidden)
    monkeypatch.setattr(subprocess, "Popen", forbidden)


def test_core_compression_rewind_withdraws_absorbed_correction(tmp_path):
    from hermes_state import SessionDB

    home = tmp_path / "glide-core"
    home.mkdir()
    db = SessionDB(db_path=home / "state.db")
    try:
        db.create_session("parent", "cli")
        retained = db.append_message(
            "parent", "user", "Correction: Keep historical checks offline.",
            message_uid="retained", timestamp=1.0)
        db.append_message(
            "parent", "user", "Please inspect the parser.",
            message_uid="anchor", timestamp=2.0)
        constituent = db.append_message(
            "parent", "user", "Correction: Use obsolete parser flags.",
            message_uid="absorbed-correction", timestamp=3.0)
        carrier = {
            "role": "user",
            "content": "Please inspect the parser.\nCorrection: Use obsolete parser flags.",
            "message_uid": "anchor",
            "_absorbed_message_uids": ["absorbed-correction"],
            "timestamp": 2.0,
        }
        holder = "glide-memory-regression"
        assert db.try_acquire_compression_lock("parent", holder)
        try:
            db.publish_compression_child(
                parent_session_id="parent", child_session_id="continued", source="cli",
                messages=[carrier], compression_lock_holder=holder)
        finally:
            db.release_compression_lock("parent", holder)

        rows = db.get_messages("continued")
        assert len(rows) == 1
        assert rows[0]["message_uid"] == "anchor"
        assert json.loads(rows[0]["absorbed_message_uids"]) == ["absorbed-correction"]
        assert db.get_session("parent")["end_reason"] == "compression"
        memory = GlideMemory(home)
        scope = ["parent", "continued"]
        assert memory.sync(scope, batch_size=1).corrections == 2
        assert memory.search("obsolete")[0].message_id == constituent

        rewound = db.rewind_to_message("continued", carrier["_row_id"])
        assert rewound["rewound_count"] == 1
        withdrawn = db.get_messages("continued", include_inactive=True)[0]
        assert (withdrawn["active"], withdrawn["compacted"]) == (0, 0)
        with pytest.raises(MemoryNotReady):
            memory.search("obsolete")
        result = GlideMemory(home).sync(scope, batch_size=1)
        assert result.complete and result.corrections == 1
        assert memory.search("obsolete") == []
        assert memory.context("obsolete") == ""
        assert memory.search("historical")[0].message_id == retained
    finally:
        db.close()
