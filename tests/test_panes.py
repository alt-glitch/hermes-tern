"""panes.py: which conversation a restarted ``hermes tern`` pane resumes. Hermes is stubbed: the
plugin's connections helpers answer from dicts, and state.db from ``sessions``."""

import json
import os
import types

import pytest

from hermes_tern_plugin import panes

DEAD = 2**22 + 12345  # no such process


@pytest.fixture()
def world(tmp_path, monkeypatch):
    folder = tmp_path / "panes"
    folder.mkdir()
    w = types.SimpleNamespace(
        folder=folder, viewed=set(), alive={os.getpid()},
        sessions={"root": {"cwd": "/work/repo"}, "tip": {"cwd": "/work/repo"}},
        lineage={"tip": ["root", "tip"]})
    monkeypatch.setattr(panes, "_connections", lambda: types.SimpleNamespace(
        _dir=lambda name: folder,
        _alive=lambda pid: pid in w.alive,
        _lineage=lambda sid: w.lineage.get(sid, [sid]),
        viewed_by_tern=lambda sid: bool(set(w.lineage.get(sid, [sid])) & w.viewed)))
    monkeypatch.setattr(panes, "_session", lambda sid: w.sessions.get(sid))

    def pane(name="7", **record):
        (folder / f"{name}.json").write_text(json.dumps(
            {"session_id": "tip", "cwd": "/home/me", "pid": DEAD, "updated_at": 0, **record}))

    w.pane = pane
    return w


def plan(flags=(), pane="7", cwd="/home/me"):
    return panes.plan(list(flags), {"TERN_PANE": pane} if pane else {}, cwd)


def test_a_pane_whose_program_died_resumes_its_conversation_by_root(world):
    world.pane()
    assert plan(["-m", "x"]) == (["--resume", "root", "-m", "x"], "root")
    claim = json.loads((world.folder / "claims" / "root.json").read_text())
    assert claim["pid"] == os.getpid() and claim["pane"] == "7"


def test_the_shell_may_stand_in_the_session_folder_tern_restored(world):
    world.pane()
    assert plan(cwd="/work/repo")[1] == "root"
    assert plan(cwd="/somewhere/else") == ([], None)


def test_nothing_to_resume_outside_tern_or_without_a_file(world):
    world.pane()
    assert plan(pane="") == ([], None)
    assert plan(pane="8") == ([], None)


@pytest.mark.parametrize("flags", [["-r", "x"], ["--resume=x"], ["-c"], ["--continue"], ["-w"], ["--worktree"]])
def test_a_session_flag_wins(world, flags):
    world.pane()
    assert plan(flags) == (flags, None)
    assert (world.folder / "7.json").exists()


def test_new_starts_fresh_and_forgets_the_pane(world):
    world.pane()
    assert plan(["--new", "-m", "x"]) == (["-m", "x"], None)
    assert not (world.folder / "7.json").exists()
    assert plan() == ([], None)


def test_a_live_program_a_gone_session_or_a_broken_file_resume_nothing(world):
    world.pane(pid=os.getpid())
    assert plan()[1] is None
    world.pane(session_id="deleted")
    assert plan()[1] is None
    (world.folder / "7.json").write_text("{not json")
    assert plan() == ([], None)


def test_two_panes_never_take_one_conversation(world):
    world.pane()
    world.viewed.add("root")  # a live pane shows it, under its root
    assert plan()[1] is None

    world.viewed.clear()
    world.pane("8")
    assert plan(pane="7")[1] == "root"
    # Pane 7's launcher (this process) holds the claim; another launcher's pane 8 does not get it.
    other = 4242
    world.alive.add(other)
    (world.folder / "claims" / "root.json").write_text(json.dumps({"pid": other}))
    assert plan(pane="8")[1] is None


def test_dead_pane_files_are_pruned_after_a_month(world):
    world.pane("1", pid=DEAD, updated_at=1.0)
    world.pane("2", pid=os.getpid(), updated_at=1.0)
    plan(pane="9")
    assert not (world.folder / "1.json").exists()
    assert (world.folder / "2.json").exists()
