"""Negative controls for the downstream gateway-only integration gate."""
import importlib.util
from pathlib import Path

import pytest


@pytest.fixture
def gate(tmp_path):
    path = Path(__file__).resolve().parents[1] / "tools/check_upstream_sync.py"
    spec = importlib.util.spec_from_file_location("sync_gate", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.ROOT = tmp_path
    (tmp_path / "frontend/src").mkdir(parents=True)
    return module


def test_gateway_only_source_passes(gate):
    (gate.ROOT / "frontend/src/client.ts").write_text("import type { GatewayClient } from '@hermes/shared/gateway-client'\n")
    assert gate.check() == []


def test_restored_reader_fails(gate):
    (gate.ROOT / "connections.py").write_text("")
    assert gate.check() == ["removed integration restored: connections.py"]


def test_deleted_import_and_gateway_mode_fail(gate):
    (gate.ROOT / "frontend/src/client.ts").write_text("import { DatabaseSync } from 'node:sqlite'\nconst mode = gw.isCanonical\n")
    assert len(gate.check()) == 2


def test_duplicate_python_handler_fails(gate):
    (gate.ROOT / "handlers.py").write_text("def run(): pass\ndef run(): pass\n")
    assert gate.check() == ["handlers.py:2: duplicate definition run"]
