"""panes.py: which conversation a restarted ``hermes tern`` pane resumes. Hermes is stubbed: the
plugin's data folder, process and session helpers answer from ``world``."""

import json
import os
import types

import pytest

from hermes_tern_plugin import panes, plugin_data, processes, sessions

DEAD = 2**22 + 12345  # no such process


@pytest.fixture()
def world(tmp_path, monkeypatch):
    folder = tmp_path / "panes"
    folder.mkdir()
    w = types.SimpleNamespace(
        folder=folder, alive={os.getpid()},
        sessions={"root": {"cwd": "/work/repo"}, "tip": {"cwd": "/work/repo"}},
        lineage={"tip": ["root", "tip"]})
    monkeypatch.setattr(plugin_data, "folder", lambda name: folder)
    monkeypatch.setattr(processes, "running", lambda pid: pid in w.alive)
    monkeypatch.setattr(sessions, "lineage", lambda sid: w.lineage.get(sid, [sid]))
    monkeypatch.setattr(sessions, "row", lambda sid: w.sessions.get(sid))

    def pane(name="7", **record):
        (folder / f"{name}.json").write_text(json.dumps(
            {"session_id": "tip", "cwd": "/home/me", "pid": DEAD, "updated_at": 0, **record}))

    w.pane = pane
    return w


def plan(pane="7", cwd="/home/me", **how):
    return panes.plan(env={"TERN_PANE": pane} if pane else {}, cwd=cwd, **how)


def test_a_pane_whose_program_died_resumes_its_conversation_by_root(world):
    world.pane()
    assert plan() == "root"
    claim = json.loads((world.folder / "claims" / "root.json").read_text())
    assert claim["pid"] == os.getpid() and claim["pane"] == "7"


def test_the_shell_may_stand_in_the_session_folder_tern_restored(world):
    world.pane()
    assert plan(cwd="/work/repo") == "root"
    assert plan(cwd="/somewhere/else") is None


def test_nothing_to_resume_outside_tern_or_without_a_file(world):
    world.pane()
    assert plan(pane="") is None
    assert plan(pane="8") is None


def test_a_launch_that_names_its_session_wins(world):
    world.pane()
    assert plan(explicit=True) is None
    assert (world.folder / "7.json").exists()


def test_new_starts_fresh_and_forgets_the_pane(world):
    world.pane()
    assert plan(fresh=True) is None
    assert not (world.folder / "7.json").exists()
    assert plan() is None


def test_a_live_program_a_gone_session_or_a_broken_file_resume_nothing(world):
    world.pane(pid=os.getpid())
    assert plan() is None
    world.pane(session_id="deleted")
    assert plan() is None
    (world.folder / "7.json").write_text("{not json")
    assert plan() is None


def test_two_panes_never_take_one_conversation(world):
    # A live pane showing it is the gateway's to know: the frontend asks before it resumes (viewer.shown).
    world.pane()
    world.pane("8")
    assert plan(pane="7") == "root"
    # Pane 7's launcher (this process) holds the claim; another launcher's pane 8 does not get it.
    other = 4242
    world.alive.add(other)
    (world.folder / "claims" / "root.json").write_text(json.dumps({"pid": other}))
    assert plan(pane="8") is None


def test_dead_pane_files_are_pruned_after_a_month(world):
    world.pane("1", pid=DEAD, updated_at=1.0)
    world.pane("2", pid=os.getpid(), updated_at=1.0)
    plan(pane="9")
    assert not (world.folder / "1.json").exists()
    assert (world.folder / "2.json").exists()
