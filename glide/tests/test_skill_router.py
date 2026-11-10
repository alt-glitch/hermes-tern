"""Tests for the skill router (tiered skill-rank)."""

import json
import pytest

from glide_plugin import skill_router


@pytest.fixture
def home(tmp_path):
    """Temp profile home for tests that don't need a database."""
    home = tmp_path / "glide_test"
    home.mkdir()
    return home


def test_skill_router_install_creates_catalog(home):
    # Install should create the catalog
    result = skill_router.install(home, force=True)
    # After force install, the state should exist with 5 categories and 19 skills
    state = skill_router.load_state(home)
    assert state is not None
    assert len(state.categories) == 5
    assert len(state.skills) == 19

    # Second install without force returns already_installed
    result2 = skill_router.install(home)
    assert result2["installed"] is False
    assert result2["reason"] == "already_installed"


def test_skill_router_rank_matches_triggers(home):
    skill_router.install(home)

    # Query with a trigger from host_hygiene category
    ranked = skill_router.rank_for_query("set up k3s cluster", home)
    assert len(ranked) >= 1
    assert ranked[0]["name"] == "home-k3s-fleet"
    assert ranked[0]["category"] == "host_hygiene"
    assert "k3s" in ranked[0]["reason"]

    # Query with a trigger from research category
    ranked = skill_router.rank_for_query("search arxiv for ML papers", home)
    assert len(ranked) >= 1
    # Should match arxiv trigger
    assert any("arxiv" in r["reason"] for r in ranked)


def test_skill_router_list_categories(home):
    skill_router.install(home)
    cats = skill_router.list_categories(home)
    assert len(cats) == 5
    cat_names = {c["category"] for c in cats}
    assert cat_names == {"host_hygiene", "debugging", "research", "creative", "coding"}

    # Check that rules and preferred order are present
    for c in cats:
        assert c["rule"]
        assert isinstance(c["preferred"], list)


def test_skill_router_command_install_and_list(home):
    # Install
    out = skill_router.command(home, "install")
    assert "installed" in out or "already installed" in out

    # List all
    out = skill_router.command(home, "list")
    assert "host_hygiene" in out
    assert "debugging" in out

    # List specific category
    out = skill_router.command(home, "list host_hygiene")
    assert "home-k3s-fleet" in out

    # Rank
    out = skill_router.command(home, "rank k3s fleet")
    assert "home-k3s-fleet" in out


def test_skill_router_persists_state(home):
    skill_router.install(home)
    state = skill_router.load_state(home)
    assert state is not None
    assert len(state.categories) == 5
    assert len(state.skills) == 19