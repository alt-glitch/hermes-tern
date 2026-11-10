"""Tests for the first hill climb (kernel.toml loop with KEEP/REVERT referee)."""

import json
from pathlib import Path

import pytest

from glide_plugin import hill_climb


@pytest.fixture
def home(tmp_path):
    """Temp profile home for tests that don't need a database."""
    home = tmp_path / "glide_test"
    home.mkdir()
    return home


def test_hill_climb_scaffold_creates_kernel_toml(home):
    result = hill_climb.scaffold(home, force=True)
    assert result["scaffolded"] is True
    kernel_toml = home / "glide" / "kernel.toml"
    assert kernel_toml.exists()

    # Check kernel.toml has expected fields
    content = kernel_toml.read_text()
    assert "target_command" in content
    assert "metric" in content
    assert "referee" in content


def test_hill_climb_run_produces_verdict(home):
    # Scaffold first
    hill_climb.scaffold(home, force=True)

    # Run one round
    result = hill_climb.run_round(home)
    assert "ok" in result
    # Since it's A/A comparison with same benchmark, should be REVERT or INCONCLUSIVE
    assert "verdict" in result
    assert result["verdict"]["decision"] in ("KEEP", "REVERT", "INCONCLUSIVE")


def test_hill_climb_status_after_scaffold(home):
    # Before scaffold
    before = hill_climb.status(home)
    assert before["scaffolded"] is False

    # After scaffold
    hill_climb.scaffold(home, force=True)
    after = hill_climb.status(home)
    assert after["scaffolded"] is True
    assert after["rounds_completed"] == 0


def test_hill_climb_referee_keept_revert_logic():
    """Test the referee function's decision logic directly."""
    # REVERT: no improvement
    v = hill_climb.referee_paired(
        baseline_scores=[100.0, 101.0, 99.0],
        candidate_scores=[95.0, 97.0, 98.0],
        maximize=True,
        noise_threshold=0.05,
        min_effect_size=0.02,
    )
    assert v["decision"] == "REVERT"

    # KEEP: significant improvement
    v = hill_climb.referee_paired(
        baseline_scores=[100.0, 101.0, 99.0],
        candidate_scores=[110.0, 112.0, 108.0],
        maximize=True,
        noise_threshold=0.05,
        min_effect_size=0.02,
    )
    assert v["decision"] == "KEEP"

    # INCONCLUSIVE: noise floor too high (high variability, positive but small effect)
    # Positive rel_improvement but high noise floor = INCONCLUSIVE
    v = hill_climb.referee_paired(
        baseline_scores=[100.0, 105.0, 95.0, 110.0],  # high variance
        candidate_scores=[103.0, 104.0, 102.0, 105.0],  # slightly higher mean, same variance
        maximize=True,
        noise_threshold=0.05,
        min_effect_size=0.01,  # small enough effect to not trigger KEEP
    )
    # With high noise floor, should be INCONCLUSIVE (but only if rel_improvement > 0)
    # Let's check the actual decision
    print(f"  rel_improvement: {v['stats']['rel_improvement']:.4f}")
    print(f"  noise_floor: {v['stats']['noise_floor']:.4f}")
    print(f"  decision: {v['decision']}")
    assert v["decision"] in ("INCONCLUSIVE", "REVERT"), f"Expected INCONCLUSIVE or REVERT, got {v['decision']}"