#!/usr/bin/env python3
"""Keep downstream code in glide/ so upstream merges stay small.

Every file this repo adds on top of upstream (alt-glitch/hermes-tern) must live under glide/,
or be listed in glide/tools/layout-baseline.txt. The baseline is what existed before this rule
plus files deliberately kept in upstream's layout because they are meant for an upstream PR
(annotate those lines with `# upstream: <PR or issue>`). The list may only shrink: a listed
path that is no longer a fork-added file fails too, so stale lines get removed.

    python glide/tools/check_layout.py [--upstream REF]   # default REF: upstream/main
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASELINE = Path(__file__).with_name("layout-baseline.txt")
# Paths GitHub only reads from fixed places; they are downstream by nature.
FIXED = {".github/README.md", ".github/workflows/glide.yml"}


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--upstream", default="upstream/main")
    ref = ap.parse_args().upstream
    base = git("merge-base", ref, "HEAD").strip()
    added = set(git("diff", "--diff-filter=A", "--name-only", base, "HEAD").split())
    outside = {p for p in added if not p.startswith("glide/") and p not in FIXED}
    allowed = {line.split("#", 1)[0].strip() for line in BASELINE.read_text().splitlines()} - {""}
    new = sorted(outside - allowed)
    stale = sorted(allowed - outside)
    for p in new:
        print(f"downstream file outside glide/: {p}  (move it under glide/, or list it in "
              f"{BASELINE.relative_to(ROOT)} with '# upstream: <PR>' if it is meant for upstream)")
    for p in stale:
        print(f"stale baseline line (no longer a fork-added file): {p}")
    print(f"layout: {len(outside)} fork-added files outside glide/, {len(new)} new, {len(stale)} stale")
    return 1 if new or stale else 0


if __name__ == "__main__":
    sys.exit(main())
