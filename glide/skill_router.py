"""Skill Router: tiered skill-rank (category → best-way rule → skills).

Installs a deterministic ranking so the model always picks the right skill.
No network, no model calls; purely local rule + metadata.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

# ---- Data structures ---------------------------------------------------------


@dataclass(frozen=True)
class SkillMeta:
    """Minimal skill metadata for ranking; extracted from SKILL.md frontmatter."""
    name: str
    description: str
    category: str
    triggers: tuple[str, ...] = ()
    priority: int = 0  # higher = more preferred within category


@dataclass(frozen=True)
class CategoryRule:
    """Best-way rule for a category."""
    category: str
    rule: str  # human-readable rule, e.g. "Prefer built-in tools over external APIs"
    preferred_order: tuple[str, ...] = ()  # skill names in preferred order


@dataclass
class SkillRouterState:
    """Persisted router state under <profile>/glide/skill_router.json."""
    schema: str = "glide.skill_router.v1"
    categories: dict[str, CategoryRule] = field(default_factory=dict)
    skills: dict[str, SkillMeta] = field(default_factory=dict)  # name -> meta
    updated_at: float = 0.0


# ---- Built-in catalog (can be extended by the user) --------------------------

# These mirror the categories and rules Kevin actually uses.
BUILTIN_CATEGORIES: dict[str, CategoryRule] = {
    "host_hygiene": CategoryRule(
        category="host_hygiene",
        rule="CPU-heavy work goes to MBP/k3s fleet; GPU work stays on groot",
        preferred_order=(
            "home-k3s-fleet",
            "remote-agent-orchestration",
            "fork-parallel-union-ci",
            "hermes-tern-version-launches",
        ),
    ),
    "debugging": CategoryRule(
        category="debugging",
        rule="Systematic 4-phase root cause before any fix; verify with real output",
        preferred_order=(
            "systematic-debugging",
            "node-inspect-debugger",
            "python-debugpy",
        ),
    ),
    "research": CategoryRule(
        category="research",
        rule="Ground every claim in cited sources; use owner-context-sweep first",
        preferred_order=(
            "owner-context-sweep",
            "grounded-citations",
            "arxiv",
            "competitor-news-monitor",
        ),
    ),
    "creative": CategoryRule(
        category="creative",
        rule="Use design skill for artifacts; Claude for one-off HTML; Blender for 3D",
        preferred_order=(
            "claude-design",
            "blender-reference-match-loop",
            "p5js",
            "architecture-diagram",
        ),
    ),
    "coding": CategoryRule(
        category="coding",
        rule="Parallel agents via subagents; enforce verification before declaring done",
        preferred_order=(
            "parallel-subagent-app-builds",
            "agentic-gitops-integration",
            "test-driven-development",
            "benchmark-driven-development",
        ),
    ),
}

# Default skills that ship with Hermes + common third-party skills.
# Priority within category: higher = more preferred.
BUILTIN_SKILLS: tuple[SkillMeta, ...] = (
    # host_hygiene
    SkillMeta("home-k3s-fleet", "Set up or verify the owner's K3s fleet", "host_hygiene", ("k3s", "fleet", "kubernetes"), 100),
    SkillMeta("remote-agent-orchestration", "Assign coding work to remote devices", "host_hygiene", ("remote", "agent", "orchestration"), 90),
    SkillMeta("fork-parallel-union-ci", "Organize fork RFCs/waves/CI or merge PR lanes", "host_hygiene", ("fork", "ci", "parallel"), 80),
    SkillMeta("hermes-tern-version-launches", "Switch, install or refresh Tern UI versions", "host_hygiene", ("tern", "version", "launch"), 70),
    # debugging
    SkillMeta("systematic-debugging", "4-phase root cause debugging", "debugging", ("debug", "root cause", "systematic"), 100),
    SkillMeta("node-inspect-debugger", "Debug Node.js via --inspect + Chrome DevTools Protocol CLI", "debugging", ("node", "inspect", "debugger"), 90),
    SkillMeta("python-debugpy", "Debug Python: pdb REPL + debugpy remote (DAP)", "debugging", ("python", "debugpy", "pdb"), 80),
    # research
    SkillMeta("owner-context-sweep", "Sweep all repos before plans or claims of absence", "research", ("owner", "context", "sweep"), 100),
    SkillMeta("grounded-citations", "Ground answers and documents in cited, verifiable sources", "research", ("citation", "grounded", "verify"), 90),
    SkillMeta("arxiv", "Search arXiv papers by keyword, author, category, or ID", "research", ("arxiv", "paper", "research"), 80),
    SkillMeta("competitor-news-monitor", "Watch named companies for material news", "research", ("competitor", "news", "monitor"), 70),
    # creative
    SkillMeta("claude-design", "Design one-off HTML artifacts (landing, deck, prototype)", "creative", ("design", "html", "prototype"), 100),
    SkillMeta("blender-reference-match-loop", "Match a Blender scene to a locked reference", "creative", ("blender", "reference", "match"), 90),
    SkillMeta("p5js", "p5.js sketches: gen art, shaders, interactive, 3D", "creative", ("p5js", "generative", "art"), 80),
    SkillMeta("architecture-diagram", "Dark-themed SVG architecture/cloud/infra diagrams as HTML", "creative", ("diagram", "architecture", "svg"), 70),
    # coding
    SkillMeta("parallel-subagent-app-builds", "Fan out builders on one app. Seams first.", "coding", ("parallel", "subagent", "build"), 100),
    SkillMeta("agentic-gitops-integration", "Integrate parallel agent Git branches locally", "coding", ("gitops", "agent", "integration"), 90),
    SkillMeta("test-driven-development", "TDD: enforce RED-GREEN-REFACTOR, tests before code", "coding", ("tdd", "test", "driven"), 80),
    SkillMeta("benchmark-driven-development", "Implement benchmark: read, explore, implement", "coding", ("benchmark", "performance"), 70),
)


# ---- Core logic --------------------------------------------------------------


def _router_path(home: Path) -> Path:
    return home / "glide" / "skill_router.json"


def load_state(home: Path) -> SkillRouterState:
    path = _router_path(home)
    if not path.exists():
        return _default_state()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("schema") != "glide.skill_router.v1":
            return _default_state()
        cats = {k: CategoryRule(**v) for k, v in data.get("categories", {}).items()}
        skills = {k: SkillMeta(**v) for k, v in data.get("skills", {}).items()}
        return SkillRouterState(categories=cats, skills=skills, updated_at=data.get("updated_at", 0.0))
    except (json.JSONDecodeError, TypeError, ValueError):
        return _default_state()


def _default_state() -> SkillRouterState:
    state = SkillRouterState()
    state.categories = dict(BUILTIN_CATEGORIES)
    state.skills = {s.name: s for s in BUILTIN_SKILLS}
    return state


def save_state(state: SkillRouterState, home: Path) -> None:
    path = _router_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    data = {
        "schema": state.schema,
        "categories": {k: asdict(v) for k, v in state.categories.items()},
        "skills": {k: asdict(v) for k, v in state.skills.items()},
        "updated_at": state.updated_at,
    }
    tmp.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def install(home: Path, *, force: bool = False) -> dict[str, Any]:
    """Install/update the skill router catalog. Returns a summary for the card."""
    state = load_state(home)
    if not force and state.categories and state.skills:
        return {
            "installed": False,
            "reason": "already_installed",
            "categories": len(state.categories),
            "skills": len(state.skills),
        }

    state = _default_state()
    state.updated_at = __import__("time").time()
    save_state(state, home)
    return {
        "installed": True,
        "categories": len(state.categories),
        "skills": len(state.skills),
    }


def rank_for_query(query: str, home: Path) -> list[dict[str, Any]]:
    """Return skills ranked by category rule match for the query.
    Returns list of {name, category, priority, reason} sorted by relevance.
    """
    state = load_state(home)
    if not state.categories or not state.skills:
        return []

    q = query.lower()
    scored: list[tuple[int, int, SkillMeta, str]] = []  # (category_match, skill_priority, skill, reason)

    for cat_name, cat_rule in state.categories.items():
        cat_match = 0
        reason = ""
        # Simple trigger: if any preferred skill's trigger appears in query
        for skill_name in cat_rule.preferred_order:
            skill = state.skills.get(skill_name)
            if skill and any(t in q for t in skill.triggers):
                cat_match = 1
                reason = f"trigger '{skill.triggers[0]}' matched {cat_name} rule"
                break

        if cat_match:
            for skill_name in cat_rule.preferred_order:
                skill = state.skills.get(skill_name)
                if skill:
                    scored.append((cat_match, skill.priority, skill, reason))

    # Sort: category match desc, then skill priority desc
    scored.sort(key=lambda x: (-x[0], -x[1]))

    # Deduplicate by skill name
    seen = set()
    results = []
    for _, _, skill, reason in scored:
        if skill.name not in seen:
            seen.add(skill.name)
            results.append({
                "name": skill.name,
                "category": skill.category,
                "priority": skill.priority,
                "description": skill.description,
                "reason": reason,
            })
    return results


def list_categories(home: Path) -> list[dict[str, Any]]:
    state = load_state(home)
    return [
        {"category": c.category, "rule": c.rule, "preferred": list(c.preferred_order)}
        for c in state.categories.values()
    ]


def list_skills(home: Path) -> list[dict[str, Any]]:
    state = load_state(home)
    return [
        {"name": s.name, "category": s.category, "description": s.description, "triggers": list(s.triggers), "priority": s.priority}
        for s in state.skills.values()
    ]


# ---- CLI / command entry -----------------------------------------------------


def command_install(home: Path, force: bool = False) -> str:
    result = install(home, force=force)
    if result["installed"]:
        return f"Skill router installed: {result['categories']} categories, {result['skills']} skills."
    return f"Skill router already installed ({result['categories']} categories, {result['skills']} skills). Use --force to reinstall."


def command_list(home: Path, category: str | None = None) -> str:
    state = load_state(home)
    if category:
        skills = [s for s in state.skills.values() if s.category == category]
        if not skills:
            return f"No skills in category '{category}'."
        lines = [f"Skills in '{category}':"]
        for s in sorted(skills, key=lambda x: -x.priority):
            lines.append(f"  {s.name} (prio {s.priority}): {s.description}")
        return "\n".join(lines)
    cats = list_categories(home)
    lines = ["Skill Router Categories:"]
    for c in cats:
        lines.append(f"  {c['category']}: {c['rule']}")
        lines.append(f"    preferred: {', '.join(c['preferred']) or '(none)'}")
    return "\n".join(lines)


def command_rank(home: Path, query: str) -> str:
    ranked = rank_for_query(query, home)
    if not ranked:
        return "Skill router not installed or no matching skills. Run '/glide skill-router install' first."
    lines = [f"Ranked skills for: \"{query}\""]
    for i, r in enumerate(ranked[:5], 1):
        lines.append(f"  {i}. {r['name']} [{r['category']}] (prio {r['priority']}): {r['reason']}")
    return "\n".join(lines)


USAGE = """/glide skill-router install          install the tiered skill catalog
/glide skill-router list [category]   list categories or skills in one category
/glide skill-router rank <query>      show ranked skills for a query
"""


def command(home: Path, args: str) -> str:
    """Main entry point for /glide skill-router subcommands."""
    parts = args.strip().split()
    if not parts:
        return USAGE
    verb = parts[0]
    rest = " ".join(parts[1:])

    if verb == "install":
        force = "--force" in rest
        result = install(home, force=force)
        if result["installed"]:
            return f"Skill router installed: {result['categories']} categories, {result['skills']} skills."
        return f"Skill router already installed ({result['categories']} categories, {result['skills']} skills). Use --force to reinstall."
    if verb == "list":
        return command_list(home, rest.strip() if rest.strip() else None)
    if verb == "rank":
        if not rest.strip():
            return "Usage: /glide skill-router rank <query>"
        return command_rank(home, rest.strip())
    return USAGE