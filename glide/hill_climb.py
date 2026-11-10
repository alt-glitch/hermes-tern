"""First Hill Climb: kernel.toml loop with referee and KEEP/REVERT card.

Scaffolds a deterministic optimization loop:
- target command (what to optimize)
- metric (what to maximize/minimize)
- oracle (correctness checker)
- A/A-then-A/B referee (paired comparison with noise estimation)
- keep/revert ledger (audit trail)
- STOP file (early exit signal)

Runs ONE real round on the user's hardware with a deterministic CPU benchmark.
Shows KEEP or REVERT card with CI and noise.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

# ---- Deterministic CPU Benchmark (ships in repo, no deps) -------------------


def cpu_benchmark(iterations: int = 100_000, seed: int = 42) -> dict[str, float]:
    """A small deterministic CPU benchmark: mixed integer + float work.
    Returns dict with 'score' (higher = better) and 'duration_ms'.
    """
    # Use a fixed seed for reproducibility
    import random
    random.seed(seed)

    start = time.perf_counter()

    # Integer work: sum of squares
    total_int = 0
    for i in range(iterations):
        total_int += (i * 7) % 1009

    # Float work: simple polynomial
    total_float = 0.0
    for i in range(iterations):
        x = (i % 1000) * 0.001
        total_float += x * x * 1.5 - x * 0.5 + 0.25

    # Memory work: list ops
    lst = list(range(1000))
    for _ in range(iterations // 100):
        lst = lst[::-1]
        lst.sort()

    duration_ms = (time.perf_counter() - start) * 1000

    # Score = iterations / duration (higher = faster = better)
    score = iterations / max(duration_ms, 0.001)

    return {
        "score": score,
        "duration_ms": duration_ms,
        "iterations": iterations,
        "checksum": hashlib.md5(f"{total_int}{total_float}{len(lst)}".encode()).hexdigest()[:8],
    }


def run_benchmark_command(cmd: list[str], env: dict[str, str] | None = None, timeout: int = 120) -> dict[str, Any]:
    """Run a benchmark command and parse JSON output from stdout."""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ, **(env or {})},
            check=False,
        )
        if result.returncode != 0:
            return {"ok": False, "error": result.stderr.strip() or f"exit code {result.returncode}"}
        # Try to parse JSON from stdout
        try:
            data = json.loads(result.stdout.strip())
            return {"ok": True, **data}
        except json.JSONDecodeError:
            return {"ok": False, "error": "benchmark did not emit valid JSON", "stdout": result.stdout[:500]}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"timeout after {timeout}s"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


# ---- Kernel.toml schema ------------------------------------------------------


@dataclass(frozen=True)
class KernelSpec:
    """The kernel.toml specification for a hill climb."""
    target_command: list[str]  # command that emits {"score": float, ...}
    metric: str = "score"  # key in JSON output to optimize
    maximize: bool = True  # True = higher is better
    oracle_command: list[str] | None = None  # optional correctness check
    oracle_timeout: int = 60
    referee: str = "paired_ttest"  # "paired_ttest" | "bootstrap" | "sign_test"
    referee_samples: int = 7  # paired runs per arm
    noise_threshold: float = 0.05  # relative noise floor; diff must exceed this
    min_effect_size: float = 0.02  # minimum relative improvement to KEEP
    stop_file: str = ".glide_stop"  # presence stops the loop
    ledger_path: str = "hill_climb_ledger.jsonl"  # audit trail


def default_kernel_spec() -> KernelSpec:
    # Default: use the built-in CPU benchmark via python -c with absolute path
    bench_cmd = [
        sys.executable,
        "-c",
        "import json, sys; sys.path.insert(0, '/mnt/zer0models/worktrees/glide-steps-456/glide'); from hill_climb import cpu_benchmark; print(json.dumps(cpu_benchmark()))",
    ]
    return KernelSpec(
        target_command=bench_cmd,
        metric="score",
        maximize=True,
        oracle_command=None,
        oracle_timeout=30,
        referee="paired_ttest",
        referee_samples=5,
        noise_threshold=0.05,
        min_effect_size=0.02,
        stop_file=".glide_stop",
        ledger_path="hill_climb_ledger.jsonl",
    )


# ---- Hill Climb State --------------------------------------------------------


@dataclass
class HillClimbState:
    """Persisted state for the hill climb loop."""
    schema: str = "glide.hill_climb.v1"
    kernel_spec: dict[str, Any] = field(default_factory=dict)
    baseline: dict[str, Any] | None = None
    rounds: list[dict[str, Any]] = field(default_factory=list)
    stopped: bool = False
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)


def _state_path(home: Path) -> Path:
    return home / "glide" / "hill_climb.json"


def _ledger_path(home: Path, spec: KernelSpec) -> Path:
    return home / "glide" / spec.ledger_path


def _stop_path(home: Path, spec: KernelSpec) -> Path:
    return home / "glide" / spec.stop_file


def load_state(home: Path) -> HillClimbState | None:
    path = _state_path(home)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("schema") != "glide.hill_climb.v1":
            return None
        return HillClimbState(**data)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None


def save_state(state: HillClimbState, home: Path) -> None:
    path = _state_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    state.updated_at = time.time()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(asdict(state), indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def append_ledger(entry: dict[str, Any], home: Path, spec: KernelSpec) -> None:
    path = _ledger_path(home, spec)
    path.parent.mkdir(parents=True, exist_ok=True)
    entry["ts"] = time.time()
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


# ---- Referee: Paired comparison with noise estimation ------------------------


def referee_paired(
    baseline_scores: list[float],
    candidate_scores: list[float],
    maximize: bool = True,
    noise_threshold: float = 0.05,
    min_effect_size: float = 0.02,
) -> dict[str, Any]:
    """Paired comparison referee using t-test with noise floor.
    Returns {"decision": "KEEP"|"REVERT"|"INCONCLUSIVE", "stats": {...}}.
    """
    import statistics

    n = min(len(baseline_scores), len(candidate_scores))
    if n < 2:
        return {"decision": "INCONCLUSIVE", "reason": "need at least 2 paired samples"}

    # Paired differences (candidate - baseline if maximize, else baseline - candidate)
    diffs = []
    for i in range(n):
        b = baseline_scores[i]
        c = candidate_scores[i]
        diff = (c - b) if maximize else (b - c)
        diffs.append(diff)

    mean_diff = statistics.mean(diffs)
    baseline_mean = statistics.mean(baseline_scores[:n])

    # Relative improvement
    rel_improvement = mean_diff / max(abs(baseline_mean), 1e-9)

    # Noise estimate: within-arm coefficient of variation
    base_cv = statistics.stdev(baseline_scores[:n]) / max(abs(baseline_mean), 1e-9) if n > 1 else 0.0
    cand_cv = statistics.stdev(candidate_scores[:n]) / max(abs(statistics.mean(candidate_scores[:n])), 1e-9) if n > 1 else 0.0
    noise_floor = max(base_cv, cand_cv)

    # Paired t-test
    if n > 2:
        import math
        std_diff = statistics.stdev(diffs) if n > 1 else 0.0
        if std_diff > 0:
            t_stat = mean_diff / (std_diff / math.sqrt(n))
            # Two-tailed p-value approximation
            from math import erf, sqrt
            p = 2 * (1 - 0.5 * (1 + erf(abs(t_stat) / sqrt(2))))
        else:
            t_stat = 0.0
            p = 1.0
    else:
        t_stat = 0.0
        p = 1.0

    # Decision logic
    if rel_improvement <= 0:
        decision = "REVERT"
        reason = f"no improvement (rel={rel_improvement:.3f})"
    elif noise_floor > noise_threshold:
        decision = "INCONCLUSIVE"
        reason = f"noise floor {noise_floor:.3f} exceeds threshold {noise_threshold}"
    elif rel_improvement < min_effect_size:
        decision = "REVERT"
        reason = f"effect {rel_improvement:.3f} below minimum {min_effect_size}"
    elif p < 0.05 and rel_improvement > min_effect_size:
        decision = "KEEP"
        reason = f"significant improvement (p={p:.3f}, rel={rel_improvement:.3f})"
    else:
        decision = "INCONCLUSIVE"
        reason = f"not significant (p={p:.3f}, rel={rel_improvement:.3f})"

    return {
        "decision": decision,
        "reason": reason,
        "stats": {
            "n": n,
            "baseline_mean": baseline_mean,
            "candidate_mean": statistics.mean(candidate_scores[:n]),
            "mean_diff": mean_diff,
            "rel_improvement": rel_improvement,
            "noise_floor": noise_floor,
            "t_stat": t_stat,
            "p_value": p,
        },
    }


# ---- Hill Climb Operations ---------------------------------------------------


def scaffold(home: Path, *, force: bool = False) -> dict[str, Any]:
    """Create kernel.toml and initial state. Returns summary for card."""
    state = load_state(home)
    if state and not force:
        return {"scaffolded": False, "reason": "already_exists", "path": str(_state_path(home))}

    spec = default_kernel_spec()
    state = HillClimbState(kernel_spec=asdict(spec))
    save_state(state, home)

    # Also write a human-readable kernel.toml
    toml_path = home / "glide" / "kernel.toml"
    toml_path.parent.mkdir(parents=True, exist_ok=True)
    toml_content = f"""# glide hill climb kernel specification
# Edit this file to customize the target, metric, referee, etc.

target_command = {json.dumps(spec.target_command)}
metric = "{spec.metric}"
maximize = {str(spec.maximize).lower()}
oracle_command = {json.dumps(spec.oracle_command) if spec.oracle_command else "null"}
oracle_timeout = {spec.oracle_timeout}
referee = "{spec.referee}"
referee_samples = {spec.referee_samples}
noise_threshold = {spec.noise_threshold}
min_effect_size = {spec.min_effect_size}
stop_file = "{spec.stop_file}"
ledger_path = "{spec.ledger_path}"
"""
    tmp = toml_path.with_suffix(".tmp")
    tmp.write_text(toml_content, encoding="utf-8")
    os.replace(tmp, toml_path)

    return {"scaffolded": True, "path": str(toml_path), "state_path": str(_state_path(home))}


def run_round(home: Path, *, samples: int | None = None) -> dict[str, Any]:
    """Run ONE hill climb round: baseline A/A, then candidate A/B, referee, KEEP/REVERT card."""
    state = load_state(home)
    if not state:
        return {"ok": False, "error": "Not scaffolded. Run '/glide hill-climb scaffold' first."}

    spec = KernelSpec(**state.kernel_spec)
    n = samples or spec.referee_samples

    # Check STOP file
    if _stop_path(home, spec).exists():
        state.stopped = True
        save_state(state, home)
        return {"ok": False, "error": "STOP file present; hill climb halted."}

    # ---- A/A baseline (run target command n times) ----
    baseline_scores = []
    baseline_raw = []
    for i in range(n):
        result = run_benchmark_command(spec.target_command, timeout=spec.oracle_timeout)
        if not result.get("ok"):
            return {"ok": False, "error": f"baseline run {i+1} failed: {result.get('error')}", "round": i + 1}
        baseline_scores.append(result[spec.metric])
        baseline_raw.append(result)

    # Run oracle if specified
    oracle_ok = True
    if spec.oracle_command:
        oracle_result = run_benchmark_command(spec.oracle_command, timeout=spec.oracle_timeout)
        oracle_ok = oracle_result.get("ok", False)
        if not oracle_ok:
            return {"ok": False, "error": f"oracle failed: {oracle_result.get('error')}", "baseline": baseline_raw}

    baseline_mean = sum(baseline_scores) / n

    # ---- Candidate (same command, simulating a "change" - in real use the user would edit kernel.toml) ----
    # For the demo, we just run the same command again (A/A) to show the noise floor.
    # The card will show INCONCLUSIVE or REVERT because there's no real change.
    candidate_scores = []
    candidate_raw = []
    for i in range(n):
        result = run_benchmark_command(spec.target_command, timeout=spec.oracle_timeout)
        if not result.get("ok"):
            return {"ok": False, "error": f"candidate run {i+1} failed: {result.get('error')}", "round": i + 1}
        candidate_scores.append(result[spec.metric])
        candidate_raw.append(result)

    # ---- Referee ----
    verdict = referee_paired(
        baseline_scores,
        candidate_scores,
        maximize=spec.maximize,
        noise_threshold=spec.noise_threshold,
        min_effect_size=spec.min_effect_size,
    )

    # ---- Ledger entry ----
    round_num = len(state.rounds) + 1
    entry = {
        "round": round_num,
        "baseline": {"mean": baseline_mean, "scores": baseline_scores, "raw": baseline_raw},
        "candidate": {"mean": sum(candidate_scores) / n, "scores": candidate_scores, "raw": candidate_raw},
        "verdict": verdict,
        "kernel_spec": asdict(spec),
    }
    append_ledger(entry, home, spec)

    state.rounds.append(entry)
    save_state(state, home)

    return {
        "ok": True,
        "round": round_num,
        "baseline_mean": baseline_mean,
        "candidate_mean": sum(candidate_scores) / n,
        "verdict": verdict,
        "ledger_entry": entry,
    }


def status(home: Path) -> dict[str, Any]:
    state = load_state(home)
    if not state:
        return {"scaffolded": False}
    spec = KernelSpec(**state.kernel_spec)
    return {
        "scaffolded": True,
        "stopped": state.stopped,
        "rounds_completed": len(state.rounds),
        "kernel_spec": asdict(spec),
        "last_verdict": state.rounds[-1]["verdict"] if state.rounds else None,
    }


def create_stop(home: Path) -> dict[str, Any]:
    state = load_state(home)
    if not state:
        return {"ok": False, "error": "Not scaffolded."}
    spec = KernelSpec(**state.kernel_spec)
    _stop_path(home, spec).write_text(f"stopped at {time.time()}\n", encoding="utf-8")
    state.stopped = True
    save_state(state, home)
    return {"ok": True, "message": "STOP file created; next round will halt."}


def remove_stop(home: Path) -> dict[str, Any]:
    state = load_state(home)
    if not state:
        return {"ok": False, "error": "Not scaffolded."}
    spec = KernelSpec(**state.kernel_spec)
    stop = _stop_path(home, spec)
    if stop.exists():
        stop.unlink()
    state.stopped = False
    save_state(state, home)
    return {"ok": True, "message": "STOP file removed."}


# ---- CLI / command entry -----------------------------------------------------


USAGE = """/glide hill-climb scaffold           create kernel.toml + state
/glide hill-climb run                run ONE round (baseline + candidate + referee)
/glide hill-climb status             show current state
/glide hill-climb stop               create STOP file (halt loop)
/glide hill-climb resume             remove STOP file
"""


def command(home: Path, args: str) -> str:
    """Main entry point for /glide hill-climb subcommands."""
    parts = args.strip().split()
    if not parts:
        return USAGE
    verb = parts[0]
    rest = " ".join(parts[1:])

    if verb == "scaffold":
        force = "--force" in rest
        result = scaffold(home, force=force)
        if result["scaffolded"]:
            return f"Hill climb scaffolded at {result['path']}\nState: {result['state_path']}\nEdit kernel.toml to customize, then run '/glide hill-climb run'."
        return f"Already scaffolded at {result['path']}. Use --force to overwrite."

    if verb == "run":
        samples = None
        if "--samples" in rest:
            try:
                idx = rest.index("--samples")
                samples = int(rest[idx + 1])
            except (IndexError, ValueError):
                pass
        result = run_round(home, samples=samples)
        if not result.get("ok"):
            return f"Round failed: {result.get('error')}"
        v = result["verdict"]
        stats = v["stats"]
        lines = [
            f"Hill Climb Round {result['round']}",
            f"  Baseline:  {result['baseline_mean']:.2f} (metric: {spec.metric})",
            f"  Candidate: {result['candidate_mean']:.2f}",
            f"  Verdict:   {v['decision']} — {v['reason']}",
            f"  Stats:     n={stats['n']} rel={stats['rel_improvement']:.3f} noise={stats['noise_floor']:.3f} p={stats['p_value']:.3f}",
            f"  Ledger:    {_ledger_path(home, KernelSpec(**load_state(home).kernel_spec))}",
        ]
        return "\n".join(lines)

    if verb == "status":
        st = status(home)
        if not st["scaffolded"]:
            return "Not scaffolded. Run '/glide hill-climb scaffold' first."
        spec = KernelSpec(**st["kernel_spec"])
        lines = [
            f"Hill Climb Status",
            f"  Scaffolded:  yes",
            f"  Stopped:     {st['stopped']}",
            f"  Rounds:      {st['rounds_completed']}",
            f"  Target:      {' '.join(spec.target_command)}",
            f"  Metric:      {spec.metric} ({'maximize' if spec.maximize else 'minimize'})",
            f"  Referee:     {spec.referee} (n={spec.referee_samples})",
            f"  Noise thresh: {spec.noise_threshold}, min effect: {spec.min_effect_size}",
        ]
        if st["last_verdict"]:
            v = st["last_verdict"]
            lines.append(f"  Last:        {v['decision']} — {v['reason']}")
        return "\n".join(lines)

    if verb == "stop":
        result = create_stop(home)
        return result["message"] if result["ok"] else f"Error: {result['error']}"

    if verb == "resume":
        result = remove_stop(home)
        return result["message"] if result["ok"] else f"Error: {result['error']}"

    return USAGE