#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
export RUNNER_TEMP="${RUNNER_TEMP:-$ROOT/.sync-results}"
mkdir -p "$RUNNER_TEMP"

checkout() {
  local directory=$1 remote=$2 sha=$3
  if [ ! -d "$directory/.git" ]; then
    git init -q "$directory"
    git -C "$directory" remote add origin "$remote"
    git -C "$directory" fetch --depth 1 origin "$sha"
    git -C "$directory" -c advice.detachedHead=false checkout --detach FETCH_HEAD
  fi
  test "$(git -C "$directory" rev-parse HEAD)" = "$sha"
}

runtime() {
  checkout .hermes-agent https://github.com/NousResearch/hermes-agent "$(cat frontend/hermes-src.lock)"
  export HERMES_SRC="$ROOT/.hermes-agent"
  test "$(bun --version)" = 1.4.3
  (cd frontend && node scripts/hermes-src.mjs && bun install ${INSTALL_FLAGS---frozen-lockfile})
}

case "${1:-all}" in
  python)
    checkout .hermes-test-core https://github.com/kvnloo/hermes-agent 0ac4e9df39eecf3ce69a3ea3c80a6dc70dd7dcd5
    uv sync --project .hermes-test-core --frozen --python 3.14
    uv run --project .hermes-test-core --frozen --no-sync --with pytest --with pytest-asyncio python -m pytest -q --junitxml="$RUNNER_TEMP/python.xml"
    (cd glide && uv run --project ../.hermes-test-core --frozen --no-sync --with pytest python -m pytest -q --ignore=tests/test_memory_core.py --junitxml="$RUNNER_TEMP/glide.xml")
    ;;
  regenerate)
    INSTALL_FLAGS='' runtime
    uv sync --project .hermes-agent --frozen --python 3.14
    export PATH="$ROOT/.hermes-agent/.venv/bin:$PATH"
    (cd frontend && bun run typecheck && bun run test src/__tests__/toolRegistry.test.ts --update && bun run bundle)
    ;;
  frontend)
    runtime
    uv sync --project .hermes-agent --frozen --python 3.14
    export PATH="$ROOT/.hermes-agent/.venv/bin:$PATH"
    (cd frontend && bun run typecheck && bun run lint && bun run check:size && bun run check:strict && bun run check:suppressions && bun run test --reporter=junit --outputFile="$RUNNER_TEMP/frontend.xml" && bun run bundle)
    python3 glide/tools/smoke_upstream_sync.py
    ;;
  *) echo 'usage: verify_upstream_sync.sh python|regenerate|frontend' >&2; exit 2 ;;
esac
