"""What Tern draws in a reply, told to the agent of a conversation a Tern pane shows.

Tern's `md` node draws more than Markdown: mermaid (through merman), svg and 3D fences, TeX math,
callouts and file links, and the frontend turns a ``MEDIA:`` line into Tern's media viewer. Nothing
in Hermes says so: a session the plugin's frontend attaches to gets the Ink TUI's platform hint.
The section is frozen into a session's prompt when its first turn builds it, and only a session a
live ``hermes tern`` pane shows gets it (the pane's viewer marker, :mod:`tern_env`; the frontend
runs only once Tern answered its handshake); the platform cannot tell (a gateway the desktop app started reads every session as ``desktop``).
"""

from __future__ import annotations

from typing import Any, Mapping

from . import tern_env

PROMPT = """<tern_rendering>
This conversation is shown in Tern, which draws your Markdown natively. Use a figure when it says more than prose; keep short answers plain, and never announce or restate a figure.
- Flow, sequence, state, structure or dependencies: a ```mermaid diagram. Tern draws (merman, Mermaid 12): flowchart, sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, gantt, gitGraph, journey, timeline, mindmap, kanban, quadrantChart, xychart, sankey-beta, packet, radar-beta, block-beta, C4Context, requirementDiagram, treemap-beta, treeView-beta, ishikawa-beta, venn-beta, swimlane-beta, railroad-beta (also -ebnf-beta, -abnf-beta, -peg-beta), wardley-beta, cynefin-beta, agentflow-beta, eventmodeling, usecase-beta, zenuml, pie. Write each header exactly as listed. Never architecture-beta (Tern does not draw it): use flowchart subgraphs or C4Context. Quote labels with spaces or punctuation: A["Parse (step 1)"]. No HTML in labels except <br/>. In sequenceDiagram, a # cuts a label short (write PR 123, not PR #123), and a participant named like a keyword needs an alias: participant E as End User.
- What mermaid cannot draw (a layout, mockup, geometry, custom chart, infographic): a ```svg block; it shows inline as a picture in the theme's colors. viewBox sets the size (1 unit is about 1px, at most 1000 wide; font-size 14 is body text). Color only with currentColor and var(--fg), var(--muted), var(--border), var(--surface), var(--accent), var(--success), var(--warning), var(--error), series var(--c1) to var(--c6). No background, no scripts, no animation, no <foreignObject>, no external href.
- Math: $...$ inline, $$...$$ on its own lines for display (a ```math fence stays code). Write a literal dollar sign as \\$.
- A 3D model as text: a ```stl, ```obj, ```ply or ```wrl block shows a model the user can turn.
- An image, PDF, video, audio or 3D file on disk: put MEDIA:/absolute/path alone on its own line; Tern shows it there. A Markdown image ![...](...) does not render here.
- Tables for comparisons (a cell that is exactly high, medium or low shows as a severity pill), task lists, and callouts: > [!NOTE], [!TIP], [!IMPORTANT], [!WARNING], [!CAUTION].
- File references become links that open the file at the line: `src/app.ts:42`. Relative paths resolve against {cwd}; for a file outside it, write the absolute path or a ~/ path.
- A full HTML page or site: write the file and run `tern open --split right /absolute/page.html`; it opens in a browser block beside the chat. HTML in a reply shows as text.
- Figures are checked after your reply; if one does not render you get its error and resend only that figure.
</tern_rendering>"""


def section(info: Mapping[str, Any]) -> str:
    """The section for a session a live Tern pane shows, else nothing."""
    if not tern_env.viewer(str(info.get("session_id") or "")):
        return ""
    return PROMPT.replace("{cwd}", str(info.get("cwd") or "the chat's working directory"))


def register(ctx) -> None:
    ctx.register_system_prompt_section("hermes-tern.rendering", section)
