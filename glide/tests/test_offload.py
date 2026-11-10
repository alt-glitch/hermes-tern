"""Tests for the offload (route to local model, savings card)."""

from pathlib import Path

import pytest

from glide_plugin import offload


@pytest.fixture
def home(tmp_path):
    """Temp profile home for tests that don't need a database."""
    home = tmp_path / "glide_test"
    home.mkdir()
    return home


def test_offload_detect_models(home):
    # Test detect_local_models
    models = offload.detect_local_models()
    # At minimum, the function should not crash
    assert isinstance(models, list)


def test_offload_savings_card_empty(home):
    card = offload.savings_card(home)
    assert card["empty"] is True
    assert "No offload tasks recorded yet" in card["message"]


def test_offload_record_and_savings(home):
    # Record an offload task
    entry = offload.record_offload(
        home,
        task_type="summarize",
        prompt="Summarize the following text: The quick brown fox jumps over the lazy dog.",
        completion="The quick brown fox jumps over the lazy dog is a classic pangram.",
        model="llama3.2:1b",
        duration_ms=30000,
    )

    assert entry.prompt_tokens > 0
    assert entry.completion_tokens > 0
    assert entry.model == "llama3.2:1b"

    # Check savings card now has data
    card = offload.savings_card(home)
    assert card["empty"] is False
    assert card["total_tasks"] >= 1
    assert card["total_tokens_saved"] > 0


def test_offload_savings_card_by_type(home):
    # Record two tasks of different types
    offload.record_offload(
        home,
        task_type="summarize",
        prompt="Summarize: hello world",
        completion="Summary: hello world",
        model="llama3.2:1b",
        duration_ms=1000,
    )
    offload.record_offload(
        home,
        task_type="classify",
        prompt="Classify: spam or not spam?",
        completion="spam",
        model="phi3:mini",
        duration_ms=500,
    )

    card = offload.savings_card(home)
    assert card["empty"] is False
    assert "summarize" in card["by_type"]
    assert "classify" in card["by_type"]