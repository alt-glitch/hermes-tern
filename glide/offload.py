"""Offload: route bulk/mechanical subtasks to local model; savings card.

Tracks tokens kept out of main context by delegating to a local model (via ollama).
Shows a savings card with token counts and cost estimate.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

# ---- Local model detection ---------------------------------------------------


def detect_local_models() -> list[dict[str, Any]]:
    """Detect available local models via ollama. Returns list of {name, size_gb, parameter_count}."""
    try:
        result = subprocess.run(
            ["ollama", "list"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if result.returncode != 0:
            return []
        lines = result.stdout.strip().split("\n")
        if len(lines) < 2:
            return []
        models = []
        for line in lines[1:]:  # skip header
            parts = line.split()
            if len(parts) >= 3:
                name = parts[0]
                # size is like "4.7GB" or "2.3GB"
                size_str = parts[2]
                size_gb = float(size_str.replace("GB", "").replace("MB", "")) / (1024 if "MB" in size_str else 1)
                models.append({"name": name, "size_gb": size_gb})
        return models
    except (FileNotFoundError, subprocess.TimeoutExpired, ValueError, IndexError):
        return []


def pick_offload_model(prefer_small: bool = True) -> str | None:
    """Pick a suitable local model for offloading.
    Prefers small, fast models (e.g., llama3.2:1b, qwen2.5:0.5b, phi3:mini).
    """
    models = detect_local_models()
    if not models:
        return None

    # Preferred models for offloading (small, fast, decent quality)
    preferred = [
        "qwen2.5:0.5b",
        "qwen2.5:1.5b",
        "llama3.2:1b",
        "llama3.2:3b",
        "phi3:mini",
        "phi3.5:mini",
        "gemma2:2b",
    ]

    available = {m["name"]: m for m in models}
    for pref in preferred:
        if pref in available:
            return pref

    # Fallback: smallest available
    if prefer_small:
        return min(models, key=lambda m: m["size_gb"])["name"]
    return models[0]["name"]


# ---- Token estimation --------------------------------------------------------


def estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 chars per token for English."""
    return max(1, len(text) // 4)


def count_tokens_in_messages(messages: list[dict[str, str]]) -> int:
    """Count tokens in a chat message list."""
    total = 0
    for m in messages:
        total += estimate_tokens(m.get("content", ""))
        total += 4  # role overhead
    return total


# ---- Offload State -----------------------------------------------------------


@dataclass
class OffloadEntry:
    """One offloaded task."""
    task_type: str  # e.g., "summarize", "extract", "format", "classify"
    prompt_tokens: int
    completion_tokens: int
    model: str
    duration_ms: float
    timestamp: float = field(default_factory=time.time)


@dataclass
class OffloadState:
    """Persisted offload tracking state."""
    schema: str = "glide.offload.v1"
    entries: list[dict[str, Any]] = field(default_factory=list)
    total_prompt_tokens: int = 0
    total_completion_tokens: int = 0
    total_duration_ms: float = 0.0
    session_start: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)


def _state_path(home: Path) -> Path:
    return home / "glide" / "offload.json"


def load_state(home: Path) -> OffloadState:
    path = _state_path(home)
    if not path.exists():
        return OffloadState()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("schema") != "glide.offload.v1":
            return OffloadState()
        return OffloadState(**data)
    except (json.JSONDecodeError, TypeError, ValueError):
        return OffloadState()


def save_state(state: OffloadState, home: Path) -> None:
    path = _state_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    state.updated_at = time.time()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(asdict(state), indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def record_offload(
    home: Path,
    task_type: str,
    prompt: str,
    completion: str,
    model: str,
    duration_ms: float,
) -> OffloadEntry:
    """Record an offloaded task."""
    state = load_state(home)
    entry = OffloadEntry(
        task_type=task_type,
        prompt_tokens=estimate_tokens(prompt),
        completion_tokens=estimate_tokens(completion),
        model=model,
        duration_ms=duration_ms,
    )
    state.entries.append(asdict(entry))
    state.total_prompt_tokens += entry.prompt_tokens
    state.total_completion_tokens += entry.completion_tokens
    state.total_duration_ms += entry.duration_ms
    save_state(state, home)
    return entry


# ---- Local model execution ---------------------------------------------------


def run_local_model(model: str, prompt: str, *, temperature: float = 0.1, max_tokens: int = 1024) -> dict[str, Any]:
    """Run a prompt via ollama. Returns {ok, completion, tokens, duration_ms}."""
    start = time.perf_counter()
    try:
        result = subprocess.run(
            ["ollama", "run", model, prompt],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        duration_ms = (time.perf_counter() - start) * 1000
        if result.returncode != 0:
            return {"ok": False, "error": result.stderr.strip() or f"exit {result.returncode}", "duration_ms": duration_ms}
        completion = result.stdout.strip()
        return {
            "ok": True,
            "completion": completion,
            "prompt_tokens": estimate_tokens(prompt),
            "completion_tokens": estimate_tokens(completion),
            "duration_ms": duration_ms,
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "timeout", "duration_ms": (time.perf_counter() - start) * 1000}
    except FileNotFoundError:
        return {"ok": False, "error": "ollama not found", "duration_ms": (time.perf_counter() - start) * 1000}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "duration_ms": (time.perf_counter() - start) * 1000}


# ---- Offload Operations ------------------------------------------------------


def offload_task(
    home: Path,
    task_type: str,
    prompt: str,
    *,
    model: str | None = None,
    temperature: float = 0.1,
    max_tokens: int = 1024,
) -> dict[str, Any]:
    """Offload a single task to a local model. Returns result + savings info."""
    chosen_model = model or pick_offload_model()
    if not chosen_model:
        return {"ok": False, "error": "No local model available. Install ollama and pull a model (e.g., 'ollama pull qwen2.5:0.5b')."}

    result = run_local_model(chosen_model, prompt, temperature=temperature, max_tokens=max_tokens)
    if not result["ok"]:
        return result

    entry = record_offload(
        home,
        task_type=task_type,
        prompt=prompt,
        completion=result["completion"],
        model=chosen_model,
        duration_ms=result["duration_ms"],
    )

    # Estimate savings vs. sending to a frontier model
    # Assume frontier model would cost ~$0.01/1k tokens (rough average)
    frontier_cost_per_1k = 0.01
    tokens_saved = entry.prompt_tokens + entry.completion_tokens
    cost_saved = (tokens_saved / 1000) * frontier_cost_per_1k

    return {
        "ok": True,
        "completion": result["completion"],
        "model": chosen_model,
        "task_type": task_type,
        "tokens_saved": tokens_saved,
        "cost_saved_usd": cost_saved,
        "duration_ms": result["duration_ms"],
    }


def savings_card(home: Path) -> dict[str, Any]:
    """Generate a savings card showing total tokens/cost kept out of main context."""
    state = load_state(home)
    if not state.entries:
        return {"empty": True, "message": "No offload tasks recorded yet."}

    # Estimate frontier cost savings
    frontier_cost_per_1k = 0.01  # $ per 1k tokens (rough blend)
    total_tokens = state.total_prompt_tokens + state.total_completion_tokens
    cost_saved = (total_tokens / 1000) * frontier_cost_per_1k

    # Breakdown by task type
    by_type: dict[str, dict[str, Any]] = {}
    for e in state.entries:
        t = e["task_type"]
        if t not in by_type:
            by_type[t] = {"count": 0, "prompt_tokens": 0, "completion_tokens": 0, "duration_ms": 0.0}
        by_type[t]["count"] += 1
        by_type[t]["prompt_tokens"] += e["prompt_tokens"]
        by_type[t]["completion_tokens"] += e["completion_tokens"]
        by_type[t]["duration_ms"] += e["duration_ms"]

    return {
        "empty": False,
        "session_duration_s": (time.time() - state.session_start),
        "total_tasks": len(state.entries),
        "total_prompt_tokens": state.total_prompt_tokens,
        "total_completion_tokens": state.total_completion_tokens,
        "total_tokens_saved": total_tokens,
        "estimated_cost_saved_usd": cost_saved,
        "total_offload_time_ms": state.total_duration_ms,
        "by_type": by_type,
        "models_used": list({e["model"] for e in state.entries}),
    }


def reset_offload(home: Path) -> dict[str, Any]:
    """Reset offload tracking for a new session."""
    path = _state_path(home)
    if path.exists():
        path.unlink()
    return {"ok": True, "message": "Offload tracking reset."}


# ---- CLI / command entry -----------------------------------------------------


USAGE = """/glide offload <task_type> <prompt>    offload a task to local model
/glide offload savings                 show savings card
/glide offload reset                   reset session tracking
/glide offload models                  list available local models
"""


def command(home: Path, args: str) -> str:
    parts = args.strip().split(maxsplit=1)
    if not parts:
        return USAGE
    verb = parts[0]
    rest = parts[1] if len(parts) > 1 else ""

    if verb == "models":
        models = detect_local_models()
        if not models:
            return "No local models detected. Install ollama and run 'ollama pull qwen2.5:0.5b'."
        lines = ["Available local models (via ollama):"]
        for m in models:
            lines.append(f"  {m['name']}  ({m['size_gb']:.1f} GB)")
        preferred = pick_offload_model()
        if preferred:
            lines.append(f"\nRecommended for offload: {preferred}")
        return "\n".join(lines)

    if verb == "savings":
        card = savings_card(home)
        if card.get("empty"):
            return card["message"]
        lines = [
            "📊 Offload Savings Card",
            f"  Session:      {card['session_duration_s']:.0f}s",
            f"  Tasks:        {card['total_tasks']}",
            f"  Tokens kept:  {card['total_tokens_saved']:,} ({card['total_prompt_tokens']:,} prompt + {card['total_completion_tokens']:,} completion)",
            f"  Cost saved:   ${card['estimated_cost_saved_usd']:.4f} (est. @ $0.01/1k)",
            f"  Offload time: {card['total_offload_time_ms']:.0f} ms",
            f"  Models:       {', '.join(card['models_used'])}",
            "",
            "  By task type:",
        ]
        for t, d in card["by_type"].items():
            tt = d["prompt_tokens"] + d["completion_tokens"]
            lines.append(f"    {t}: {d['count']} tasks, {tt:,} tokens, {d['duration_ms']:.0f} ms")
        return "\n".join(lines)

    if verb == "reset":
        result = reset_offload(home)
        return result["message"]

    # Offload a task: /glide offload <task_type> <prompt>
    if not rest:
        return USAGE
    task_type, prompt = rest.split(maxsplit=1) if " " in rest else (rest, "")
    if not prompt:
        return "Usage: /glide offload <task_type> <prompt>"

    result = offload_task(home, task_type, prompt)
    if not result["ok"]:
        return f"Offload failed: {result['error']}"

    lines = [
        f"✅ Offloaded to {result['model']} ({result['task_type']})",
        f"  Tokens saved: {result['tokens_saved']:,}  |  Est. cost saved: ${result['cost_saved_usd']:.4f}",
        f"  Duration: {result['duration_ms']:.0f} ms",
        "",
        "Completion:",
        result["completion"][:500] + ("..." if len(result["completion"]) > 500 else ""),
    ]
    return "\n".join(lines)