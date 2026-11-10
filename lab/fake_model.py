"""A loopback OpenAI-compatible model for driving `hermes tern` without credentials.

    python lab/fake_model.py --home DIR [--port N]

Writes a disposable HERMES_HOME at DIR (config pointing at this server, the plugin enabled,
first-run prompts answered) and then serves until killed. What the model does is picked by
the user's prompt, so one home covers every flow:

    "approve"   -> a terminal call Hermes flags as dangerous (approval sheet); "approve long": a long one
    "clarify"   -> a clarify call with choices (clarify sheet)
    "tool"      -> a harmless terminal call (tool card)
    "steps"     -> four calls in a row (commands, a read, a search), then an answer
    "work…"     -> (at the start) a turn like a real one: reasoning, short notes and tool calls
                   in rounds (commands, reads, a search, a slow command), then a long answer
    "script"    -> a heredoc script with sections and long output, run alone
    "slow"      -> one 8-second command, long enough to queue or steer a message
    "solo…"     -> (at the start) one delegated agent with a long brief (context)
    "delegate…" -> (at the start) a delegate_task batch of three subagents, each running two slow
                   terminal calls before a slowly streamed answer; "delegate slow…": two 12 s calls
                   each, long enough to open the hub, the pane beside the chat, or quit and resume
    "nested…"   -> (at the start) one orchestrator subagent that delegates one slow worker of its own
    "delegate tiles…" -> six subagents with progress notes and two 45 s terminal steps, for tile/overflow capture
    "background…" -> (at the start) a 90 s ticking background process that notifies on exit
    "watch…"    -> (at the start) a 2 min ticking background process watching for "tick 10"
    "jobchart…" -> (at the start) a 2 min background benchmark printing tok/s and loss against a
                   stated goal, then a 40 s `process_manage` wait on it; after 15 s the plugin asks this model
                   for its chart spec, and the shells pill charts it (hover it for the tiles), as
                   do its card, the wait card and /ps
    "errands…"  -> (at the start) a four-item todo list worked through over slow steps
    "todos…"    -> (at the start) a long todo list (16 items: long ones that wrap, done, cancelled,
                   subtasks under parents), then a long answer for the open panel to sit over
    "connect APP…" -> (at the start) a manage_connections connect for the apps named (the
                   gateway's connection card; it mints real links under a guest identity)
    "install APP…" -> (at the start) a manage_connections install of those local MCP servers (the
                   card shows what Connect runs; approving it installs the server into the lab home)
    "connector…" -> (at the start) a tool search, a two-app connector batch and one connector call
    "replay ID" -> runs recorded job ID from $FAKE_MODEL_REPLAY/commands.json in the background,
                   and answers its chart request with $FAKE_MODEL_REPLAY/ID.spec.json (the rules
                   the auxiliary model wrote for it in lab/chartbench.ts): real charts in the lab
    "ternenv"   -> (at the start) prints the TERN_* variables from a command, a background command and a Python cell's command
    "pr [URL…]" -> (at the start) links the PR URLs given, else a real public PR (link_pull_request)
    "sublink [URL]" -> (at the start) one subagent that links the PR URL given, else a real public PR:
                   the parent's transcript gets no link result, so its pane learns of the link
                   from the plugin's event alone
    "cron…"     -> (at the start) two cron jobs: a 30 min digest and a 15 min page monitor
    anything else -> a streamed markdown reply
"""

import argparse
import json
import re
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]

REPLY = """Here is **markdown** from the fake model.

- a list item
- another one

```python
print("hello from hermes tern")
```
"""


STEPS = [
    ("terminal", {"command": "ls"}),
    ("read_file", {"path": "README.md"}),
    ("terminal", {"command": "git log --oneline -3"}),
    ("search_files", {"pattern": "def ", "path": "lab"}),
]

# One round per model request: (reasoning, a note to the user, tool calls). The last has no calls.
WORK = [
    ("I should start by exploring the project to get oriented: the layout, the docs, and the recent history.",
     "I'll start by reading the repo layout, the docs, and recent history.",
     [("terminal", {"command": "ls -la && echo --- && git log --oneline | wc -l && git log --oneline | head -5"}),
      ("terminal", {"command": "cat README.md | head -20 && echo --- && cat plugin.yaml"}),
      ("terminal", {"command": "git log --reverse --format='%h %ad %s' --date=short | head -10"})]),
    ("There's a lab directory with the fake model; I should check it out.",
     "The README points to `lab/` for the fake model. I'll look there next.",
     [("read_file", {"path": "lab/fake_model.py"}),
      ("search_files", {"pattern": "def ", "path": "lab"}),
      ("read_file", {"path": "docs/spec.md"})]),
    ("The spec lists milestones. Let me check the frontend tests and run a slower step.",
     None,
     [("terminal", {"command": "sleep 3 && ls frontend/src | head -20"}),
      ("write_file", {"path": "/tmp/hermes-tern-lab-note-{n}.md", "content": "lab note\n"})]),
    ("**Summarizing**\n\nI have enough to answer now: the plugin, the lab and the spec.",
     """Here is what I found.

## The plugin

`hermes tern` is a **Tern-native** frontend for Hermes. It lives in `frontend/` and ships as a
committed bundle.

- The lab drives it with a fake model.
- The spec lists milestones M1 to M8.

## Next steps

1. Read `docs/spec.md` for the order.
2. Run the lab before each change.
""",
     []),
]

SCRIPT = """cat > /tmp/hermes-tern-lab.sh <<'EOF'
echo "== disk usage =="
df -h / | tail -1
echo "== biggest folders =="
ls -1 /usr | head -5
echo "== numbers =="
seq 1 120
EOF
sh /tmp/hermes-tern-lab.sh 2>&1 | cut -c1-120"""

TICKS = "for i in $(seq 1 {n}); do echo tick $i; sleep 1; done"

SUBAGENT_MARKER = "You are a focused subagent"

SUBAGENT_GOALS = [
    "Survey the repository layout and name the top-level folders",
    "Read the clock twice, a few seconds apart",
    "Count the markdown files under the current folder",
]

SUBAGENT_STEPS = [
    "sleep 3 && ls | head -5",
    "sleep 4 && date && find . -maxdepth 2 -name '*.md' | wc -l",
]

TILE_MARKER = "Lab delegate tiles"
TILE_GOALS = [
    "Survey repository folders",
    "Read the lab workflow",
    "Inspect agent progress events",
    "Review tool intent headlines",
    "Check settled task summaries",
    "Inspect dock agent navigation",
]
TILE_STEPS = [
    ("I have scoped the read-only survey.\nI am collecting the first progress sample.",
     "printf 'Collecting the first progress sample\\n'; sleep 45; printf 'First sample collected\\n'"),
    ("The first progress sample is collected.\nI am checking the second sample before reporting.",
     "printf 'Checking the second progress sample\\n'; sleep 45; printf 'Second sample collected\\n'"),
]

# "delegate slow…": the goals say so, and a child whose goal does takes these steps instead.
SLOW = " (slowly)"
SLOW_SUBAGENT_STEPS = [
    "sleep 12 && ls | head -5",
    "sleep 12 && date && find . -maxdepth 2 -name '*.md' | wc -l",
]

# "nested…": an orchestrator child whose goal says so delegates one slow worker of its own.
ORCHESTRATE_GOAL = "Orchestrate: hand the clock reading to a worker of your own"
WORKER_GOAL = "Read the clock twice, a few seconds apart" + SLOW

SOLO_GOAL = "Read-only on the repo (only write the one output file). Verify which cleanup candidates in the audit are still dead code."
SOLO_CONTEXT = """Repo checkout (read-only) at origin/main. Do not fetch; work on this snapshot and note the commit.

Candidates to check (find more in the audit reports if they qualify):
- One-shot runtime: hermes_cli/oneshot.py run_oneshot
- Legacy console script `hermes-agent`
- RL/datagen root modules: batch_runner.py, mini_swe_runner.py

For EACH candidate record: callers, tests that exist only for it, the old-updater surface, the plugin surface, whether it is user-facing, the last meaningful touch, a verdict with file:line evidence, and the line count removed.

Work in small steps and append findings to the output file as you go. Conservative bar: if unsure, NEEDS DECISION, never DELETE."""

SUBAGENT_REPLY = """Finished the delegated task.

- ran two terminal steps
- found nothing alarming

The parent can take it from here.
"""


COMPACTION_SUMMARY = """## Goal
Try the lab's chat surface: a greeting, the repo tour and one more thing.

## Progress
- Answered each prompt with the canned reply.

## Next steps
- Wait for the next prompt."""


EVAL_CODE = (
    "import json\n"
    "calls=[{'name': 'connectors__linear__RUN_QUERY_OR_MUTATION', 'arguments': {'query_or_mutation': "
    "'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }', "
    "'variables': {'input': {'teamId': 'c75abc07-3a64-46f8-83fc-9e0fe53b80ed', 'projectId': '3f9ddca6-6f21-4'}}}}]\n"
    "print(json.dumps(calls)[:300])"
)


def _todos(*statuses: str) -> tuple[str, dict]:
    items = ["Read the failing test", "Run the test suite", "Fix the timing assumption", "Run the suite again"]
    todos = [{"id": str(i + 1), "content": c, "status": st} for i, (c, st) in enumerate(zip(items, statuses))]
    # todo_list is deferred behind Tool Search: the bridge reaches it.
    return ("tool_call", {"name": "todo_list", "arguments": {"todos": todos}})


ERRANDS = [
    ("I'll plan this as four errands.", [_todos("in_progress", "pending", "pending", "pending")]),
    ("Reading the test first.", [("terminal", {"command": "sleep 2 && echo read"})]),
    ("Now the suite.", [_todos("completed", "in_progress", "pending", "pending"), ("terminal", {"command": "sleep 3 && echo '3 failed'"})]),
    ("Fixing it.", [_todos("completed", "completed", "in_progress", "pending"), ("terminal", {"command": "sleep 2 && echo fixed"})]),
    ("All four errands are done.", []),
]


PR_URL = r"https://[^\s/]+/[^\s/]+/[^\s/]+/pull/\d+"
DEFAULT_PR = "https://github.com/alt-glitch/hermes-tern/pull/22"
# The goal the "sublink" prompt gives its subagent; the subagent's first move reads the URL from it.
SUBLINK_GOAL = "Link the pull request "


def _subagent_calls(messages: list[dict]) -> list[dict] | None:
    """A subagent's next move: one slow terminal step per earlier tool result, then the answer.
    An orchestrator (its goal says so) first delegates one worker and waits for it. The "sublink"
    subagent links its pull request first."""
    goal = next((str(m.get("content")) for m in messages if m.get("role") == "user"), "")
    done = sum(1 for m in messages if m.get("role") == "tool")
    if ORCHESTRATE_GOAL in goal:
        return None if done else [_call("delegate_task", {"goal": WORKER_GOAL}, "call-worker")]
    if SUBLINK_GOAL.lower() in goal.lower():
        url = re.search(PR_URL, goal)
        link = _call("tool_call", {"calls": [{"name": "link_pull_request", "arguments": {"url": url.group(0) if url else DEFAULT_PR}}]}, "call-sublink")
        return None if done else [link]
    steps = SLOW_SUBAGENT_STEPS if SLOW in goal else SUBAGENT_STEPS
    if done >= len(steps):
        return None
    return [_call("terminal", {"command": steps[done]}, f"call-step{done}")]


def _calls(prompt: str, target: Path) -> list[dict] | None:
    words = prompt.lower()
    # Only a prompt that starts with it: the parent's completion notice quotes the delegation and
    # would otherwise dispatch again, forever.
    if words.lstrip().startswith("delegate tiles"):
        return [_call("delegate_task", {"tasks": [
            {"goal": g, "context": TILE_MARKER + ": use the loopback progress sequence."}
            for g in TILE_GOALS
        ]})]
    if words.lstrip().startswith("delegate"):
        slow = SLOW if words.split()[1:2] == ["slow"] else ""
        return [_call("delegate_task", {"tasks": [{"goal": g + slow} for g in SUBAGENT_GOALS]})]
    if words.lstrip().startswith("nested"):
        return [_call("delegate_task", {"goal": ORCHESTRATE_GOAL, "role": "orchestrator"})]
    if words.lstrip().startswith("solo"):
        # One delegated agent with a long brief, as a real audit hand-off reads.
        return [_call("delegate_task", {"goal": SOLO_GOAL, "context": SOLO_CONTEXT})]
    if words.lstrip().startswith("slow"):
        return [_call("terminal", {"command": "sleep 8 && echo slept"})]
    if words.lstrip().startswith("background"):
        return [_call("terminal", {"command": TICKS.format(n=90), "background": True, "notify_on_complete": True})]
    if words.lstrip().startswith("replay ") and REPLAY:
        # A recorded job from $FAKE_MODEL_REPLAY/commands.json (lab/chartbench.ts's showcase).
        command = json.loads((REPLAY / "commands.json").read_text()).get(words.split()[1])
        return [_call("terminal", {"command": command, "background": True})] if command else None
    if words.lstrip().startswith("jobchart"):
        return [_call("terminal", {"command": BENCH, "background": True})]
    if words.lstrip().startswith("watch"):
        # `notify` is the advertised flag (tools/terminal_tool.py): a list watches for those lines.
        return [_call("terminal", {"command": TICKS.format(n=120), "background": True, "notify": ["tick 10"]})]
    if words.lstrip().startswith("connect "):
        # A manage_connections connect for the apps named: the gateway's connection card. A real
        # connect, so the scratch home gets a guest identity and real links (nothing is authorized).
        apps = re.findall(r"[a-z][a-z0-9_-]*", words.split(None, 1)[1]) or ["figma"]
        return [_call("manage_connections", {"action": "connect", "connectors": apps}, "call-connect")]
    if words.lstrip().startswith("install "):
        # A manage_connections install of the catalog's local MCP servers named: the card shows what
        # Connect would run. Approving it really installs the server into the lab's home.
        apps = re.findall(r"[a-z][a-z0-9_-]*", words.split(None, 1)[1]) or ["figma"]
        return [_call("manage_connections", {"action": "install", "connectors": [{"name": a, "mcp": True} for a in apps]}, "call-install")]
    if words.lstrip().startswith("connector"):
        # Connectors come through the tool_call bridge as a batch; the lab has none connected,
        # so each entry fails, which is what the batch view must show too.
        return [
            _call("tool_search", {"queries": ["create a linear issue"]}, "call-search"),
            _call("tool_call", {"calls": [
                {"name": "connectors__linear__LINEAR_CREATE_ISSUE", "arguments": {"title": "Lab issue", "team": "ENG"}},
                {"name": "connectors__slack__SLACK_SEND_MESSAGE", "arguments": {"channel": "#lab", "text": "hi"}},
            ]}, "call-batch"),
            _call("tool_call", {"name": "connectors__linear__LINEAR_LIST_ISSUES", "arguments": {"limit": 3}}, "call-one"),
        ]
    if words.lstrip().startswith("sublink"):
        url = re.search(PR_URL, prompt)
        return [_call("delegate_task", {"goal": SUBLINK_GOAL + (url.group(0) if url else DEFAULT_PR)})]
    if words.lstrip().startswith("pr"):
        # A real public PR, linked the way an agent links one it opened (through the tool_call bridge
        # in case Tool Search defers the plugin's tools).
        # Any host: the tool, not the model, decides which hosts a link may name.
        urls = re.findall(PR_URL, words) or [DEFAULT_PR]
        return [_call("tool_call", {"calls": [{"name": "link_pull_request", "arguments": {"url": u}} for u in urls]}, "call-link")]
    if words.lstrip().startswith("cron"):
        # cronjob_manage is a deferred tool: the model reaches it through the tool_call bridge.
        return [
            _call("tool_call", {"name": "cronjob_manage", "arguments": {
                "action": "create", "name": "lab digest", "schedule": "every 30m", "prompt": "Summarise the lab notes."}}, "call-cron"),
            _call("tool_call", {"name": "cronjob_manage", "arguments": {
                "action": "create", "name": "lab page watch", "schedule": "every 15m",
                "prompt": "Say what changed on the page.", "monitor": "https://example.com"}}, "call-monitor"),
        ]
    if words.lstrip().startswith("ternenv"):
        # The Tern variables each kind of child process sees: a command, a background one, a Python cell's command.
        return [_call("terminal", {"command": "env | grep ^TERN_ | sort"}, "call-env"),
                _call("terminal", {"command": "echo bg $TERN_PANE", "background": True}, "call-env-bg"),
                _call("execute_code", {"code": "from hermes_tools import terminal\nprint('code', terminal('echo $TERN_PANE')['output'])"}, "call-env-code")]
    if words.lstrip().startswith("eval"):
        # A Python cell whose output is one long line, as an agent peeking at a JSON file prints.
        return [_call("execute_code", {"code": EVAL_CODE})]
    if words.lstrip().startswith("script"):
        return [_call("terminal", {"command": SCRIPT})]
    if "approve" in words:
        target.mkdir(exist_ok=True)
        if "long" in words:
            # A chained command longer than the sheet is wide, as agents write them.
            loop = " && ".join(f"for f in agent/{m}.py tests/test_{m}.py; do wc -l $f; done" for m in ("chat", "tools", "memory"))
            return [_call("terminal", {"command": f"cd {target} && {loop} && rm -rf -- {target}"})]
        return [_call("terminal", {"command": f"rm -rf -- {target}"})]
    if "clarify" in words:
        return [_call("clarify", {"questions": [{"question": "Which colour?", "choices": ["red", "green", "blue"]}]})]
    if "tool" in words:
        return [_call("terminal", {"command": "echo tool-ok && ls"})]
    return None


def _call(name: str, arguments: dict, call_id: str = "") -> dict:
    return {"id": call_id or f"call-{name}", "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}


# A benchmark whose output a chart can read: a throughput wave around a goal the command states.
BENCH = ("for i in $(seq 1 120); do echo \"step $i tok/s=$((150 + (i * 37) % 70)) loss=0.$((99 - i * 2 / 3))\"; "
         "sleep 1; done  # decode bench, goal 200 tok/s")

# Replays of recorded jobs: their commands and the chart specs the auxiliary model wrote for them.
REPLAY = Path(os.environ["FAKE_MODEL_REPLAY"]) if os.environ.get("FAKE_MODEL_REPLAY") else None

# The plugin's chart request (frontend/src/processes/widgets/author.ts) and the spec this model writes for BENCH.
WIDGET_MARKER = "You design the live status widget"
BENCH_SPEC = {
    "title": "decode bench · tok/s",
    "rules": [{"from": "out", "match": "^step (?P<step>\\d+) tok/s=(?P<tps>[\\d.]+) loss=(?P<loss>[\\d.]+)"}],
    "blocks": [
        {"kind": "spark", "field": "tps", "label": "tok/s", "unit": "tok/s", "better": "higher", "target": 200, "targetLabel": "goal 200"},
        {"kind": "meter", "field": "step", "agg": "last", "total": 120, "label": "steps"},
        {"kind": "stat", "items": [{"field": "loss", "agg": "last", "label": "loss", "digits": 2, "better": "lower"},
                                   {"field": "tps", "agg": "max", "label": "best", "unit": "tok/s"}]},
    ],
    "headline": {"field": "tps", "agg": "last", "unit": "tok/s", "better": "higher"},
}


class Server(ThreadingHTTPServer):
    target: Path


# A list as long as a real plan gets: items that wrap, done and dropped ones, subtasks.
LONG_TODOS = [
    {"id": "setup", "content": "Set up the scratch box, audit the prompts and take stock of the skills", "status": "completed"},
    {"id": "plan", "content": "Plan the second audit with the reviewer: the per-system loop, the checkpoints and the pilot", "status": "in_progress"},
    {"id": "run", "content": "Run the second audit on the scratch box once the plan is agreed", "status": "pending"},
    {"id": "run-a", "parent": "run", "content": "Gateway and sessions", "status": "completed"},
    {"id": "run-b", "parent": "run", "content": "Tools, the terminal and background processes, with their approvals and the guards that wrap them", "status": "in_progress"},
    {"id": "run-c", "parent": "run", "content": "Memory and skills", "status": "pending"},
    {"id": "run-d", "parent": "run", "content": "Cron jobs", "status": "cancelled"},
    {"id": "rearch", "content": "Make the rearchitecture plan from the audit's results, and shape the tickets with the two leads", "status": "pending"},
    {"id": "phase0", "content": "Monorepo phase 0: guide the spec; the work runs on the scratch box in the pane beside this session", "status": "pending"},
    {"id": "flows", "content": "Spec the execution flows: session and subagent skill bundles (the dev skill, the architecture skill, the rules)", "status": "pending"},
    {"id": "review", "content": "Encode PR review babysitting: both reviewers until reviewed, clear PR descriptions", "status": "pending"},
    {"id": "issues", "content": "Encode issue artifacts: an HTML explainer per stacked PR, train, issue or PR", "status": "pending"},
    {"id": "skill", "content": "Write the architecture-work skill that the execution flows load", "status": "pending"},
    {"id": "docs", "content": "Update the docs", "status": "pending"},
    {"id": "ship", "content": "Ship it", "status": "pending"},
    {"id": "retro", "content": "Write the retro", "status": "pending"},
]

LONG_ANSWER = """The plan is in the todo list: sixteen items, one under way.

- **Scratch box:** set up. The prompt audit and the skills inventory are done, and nothing on
  the main checkout changed.
- **Second audit:** the per-system loop runs one subagent per system, with a checkpoint after
  each so you can stop it. The pilot is the gateway, because its sessions are the smallest part.
- **Rearchitecture:** waits for the audit. The tickets come from its findings, not before.

Nothing stays read-only on the repo after the plan is agreed. No test runs unless a brief
allows one. The skills the loop needs were missing on the scratch box; the setup subagent
installed them and pushed the rules.

Open the todo list from its pill to follow along."""

TODOS_FLOW = [
    ("I'll lay the work out as a todo list first.", [("tool_call", {"name": "todo_list", "arguments": {"todos": LONG_TODOS}})]),
    (LONG_ANSWER, []),
]


class Model(BaseHTTPRequestHandler):
    server: Server

    def log_message(self, format, *args):
        pass

    def do_GET(self):
        self._json({"data": [{"id": "fake-model", "object": "model"}]})

    def do_POST(self):
        arrived = time.time()
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        messages = request.get("messages", [])
        names = sorted(t.get("function", {}).get("name", "") for t in request.get("tools") or [])
        print(f"ARRIVE {arrived:.3f} msgs={len(messages)} tools={len(names)} bytes={self.headers['Content-Length']}", flush=True)
        if os.environ.get("FAKE_MODEL_TOOLS"):
            print("TOOLS " + " ".join(names), flush=True)
        prompt = next((m.get("content") for m in reversed(messages) if m.get("role") == "user"), "") or ""
        if isinstance(prompt, list):
            prompt = " ".join(p.get("text", "") for p in prompt if isinstance(p, dict))
        system = next((m.get("content") for m in messages if m.get("role") == "system"), "") or ""
        if isinstance(system, str) and WIDGET_MARKER in system:
            # The chart request: one `respond` call, a skip for anything but the bench.
            replayed = re.search(r"replay/([\w-]+)\.src", str(prompt))
            if replayed and REPLAY and (REPLAY / f"{replayed.group(1)}.spec.json").exists():
                spec = json.loads((REPLAY / f"{replayed.group(1)}.spec.json").read_text())
            else:
                spec = BENCH_SPEC if "tok/s=" in str(prompt) else {"skip": "nothing to chart"}
            content, calls, delay = None, [_call("respond", spec, "call-respond")], 0.5
        elif not names and "summar" in (prompt + str(system)).lower():
            # Context compaction's summary call: a slow, short handoff, so the running rule shows.
            content, delay = COMPACTION_SUMMARY, 2.5
            calls = None
        elif isinstance(system, str) and SUBAGENT_MARKER in system:
            tile_mode = TILE_MARKER in str(messages)
            done = sum(1 for m in messages if m.get("role") == "tool")
            if tile_mode and done < len(TILE_STEPS):
                content, command = TILE_STEPS[done]
                calls = [_call("terminal", {"command": command}, f"call-tile{done}")]
            else:
                calls = None if tile_mode else _subagent_calls(messages)
                content = None if calls else SUBAGENT_REPLY
            delay = 0.15
        elif prompt.lower().lstrip().startswith("work"):
            # One round per request: the assistant messages since the prompt count the rounds done.
            last_user = max(i for i, m in enumerate(messages) if m.get("role") == "user")
            done = sum(1 for m in messages[last_user:] if m.get("role") == "assistant")
            thought, note, round_calls = WORK[min(done, len(WORK) - 1)]
            # A fresh note file per turn: Hermes refuses to overwrite a file the task has not read.
            fresh = lambda a: {k: v.replace("{n}", str(time.time_ns())) if k == "path" else v for k, v in a.items()}
            calls = [_call(name, fresh(args), f"call-w{done}-{i}") for i, (name, args) in enumerate(round_calls)] or None
            if request.get("stream"):
                self._stream(note, calls, 0.12, thought)
                return
            content = note
            delay = 0.0
        elif prompt.lower().lstrip().startswith("errands"):
            # A todo list worked through: one round per request, as the work prompt does.
            last_user = max(i for i, m in enumerate(messages) if m.get("role") == "user")
            done = sum(1 for m in messages[last_user:] if m.get("role") == "assistant")
            note, round_calls = ERRANDS[min(done, len(ERRANDS) - 1)]
            calls = [_call(name, args, f"call-e{done}-{i}") for i, (name, args) in enumerate(round_calls)] or None
            if request.get("stream"):
                self._stream(note, calls, 0.05)
                return
            content = note
            delay = 0.0
        elif prompt.lower().lstrip().startswith("todos"):
            last_user = max(i for i, m in enumerate(messages) if m.get("role") == "user")
            done = sum(1 for m in messages[last_user:] if m.get("role") == "assistant")
            note, round_calls = TODOS_FLOW[min(done, len(TODOS_FLOW) - 1)]
            calls = [_call(name, args, f"call-t{done}-{i}") for i, (name, args) in enumerate(round_calls)] or None
            content, delay = note, 0.0
        elif "steps" in prompt.lower():
            # One call per request until the steps run out; the tool results so far count them.
            last_user = max(i for i, m in enumerate(messages) if m.get("role") == "user")
            done = sum(1 for m in messages[last_user:] if m.get("role") == "tool")
            calls = [_call(*STEPS[done], f"call-s{done}")] if done < len(STEPS) else None
            content = None if calls else "All four steps ran."
            delay = 0.0
        else:
            answered = bool(messages) and messages[-1].get("role") == "tool"
            calls = None if answered else _calls(prompt, self.server.target)
            # jobchart: once the bench started, wait on it for a while, as an agent watching it would.
            started = re.search(r"proc_[0-9a-f]+", str(messages[-1].get("content"))) if answered else None
            if started and prompt.lower().lstrip().startswith("jobchart") and not any(
                    "process" in json.dumps(m.get("tool_calls") or "") for m in messages):
                # `process_manage` is deferred behind Tool Search: the bridge reaches it.
                wait = {"name": "process_manage", "arguments": {"action": "wait", "session_id": started.group(0), "timeout": 40}}
                calls, answered = [_call("tool_call", wait, "call-wait")], False
            content = "Done: the tool returned." if answered else (None if calls else REPLY)
            delay = 0.0
        if request.get("stream"):
            self._stream(content, calls, delay)
        else:
            time.sleep(delay)
            message = {"role": "assistant", "content": content, **({"tool_calls": calls} if calls else {})}
            self._json({"id": "fake", "object": "chat.completion", "created": 1, "model": "fake-model",
                        "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if calls else "stop"}],
                        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}})

    def _stream(self, content: str | None, calls: list[dict] | None, delay: float = 0.0, reasoning: str | None = None):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        deltas = []
        if reasoning:
            step = max(1, len(reasoning) // 5)
            deltas += [{"role": "assistant", "reasoning_content": reasoning[i:i + step]} for i in range(0, len(reasoning), step)]
        if content and (calls or reasoning) or not calls:
            # A few chunks so the transcript visibly streams.
            text = content or ""
            step = max(1, len(text) // 6)
            deltas += [{"role": "assistant", "content": text[i:i + step]} for i in range(0, len(text), step)]
        if calls:
            deltas.append({"role": "assistant", "tool_calls": [{**c, "index": i} for i, c in enumerate(calls)]})
        for delta in deltas:
            self._chunk(delta, None)
            if delay:
                self.wfile.flush()
                time.sleep(delay)
        self._chunk({}, "tool_calls" if calls else "stop")
        # The usage chunk OpenAI sends last for stream_options.include_usage, so turns show their totals.
        usage = {"prompt_tokens": 1200, "completion_tokens": 340, "total_tokens": 1540,
                 "prompt_tokens_details": {"cached_tokens": 900}}
        frame = {"id": "fake", "object": "chat.completion.chunk", "created": 1, "model": "fake-model", "choices": [], "usage": usage}
        self.wfile.write(f"data: {json.dumps(frame)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _chunk(self, delta: dict, finish: str | None):
        frame = {"id": "fake", "object": "chat.completion.chunk", "created": 1, "model": "fake-model",
                 "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        self.wfile.write(f"data: {json.dumps(frame)}\n\n".encode())

    def _json(self, body: dict):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def write_home(home: Path, base_url: str) -> Path:
    home.mkdir(parents=True, exist_ok=True)
    plugins = home / "plugins"
    plugins.mkdir(exist_ok=True)
    link = plugins / "hermes-tern"
    if not link.exists():
        link.symlink_to(PLUGIN, target_is_directory=True)
    # JSON is YAML: no PyYAML needed here.
    (home / "config.yaml").write_text(json.dumps({
        "model": {"provider": "custom", "default": "fake-model", "base_url": base_url},
        "approvals": {"mode": "manual", "timeout": 300},
        "auxiliary": {"title_generation": {"enabled": False}},
        "plugins": {"enabled": ["hermes-tern"], "disabled": []},
        "telemetry": {"shared_metrics": {"enabled": False, "send": False, "offer_version": 2}},
        # A short tail, so /compress has something to summarize after a few turns.
        "compression": {"protect_last_n": 2, "protect_first_n": 0},
        # Room for "nested…": an orchestrator child may spawn one level of workers.
        "delegation": {"max_spawn_depth": 2},
    }, indent=2))
    (home / ".env").write_text("OPENAI_API_KEY=loopback-only\n")
    target = home / "approve-target"
    target.mkdir(exist_ok=True)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--home", required=True, type=Path)
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    server = Server(("127.0.0.1", args.port), Model)
    base_url = f"http://127.0.0.1:{server.server_port}/v1"
    server.target = write_home(args.home.resolve(), base_url)
    print(f"fake model at {base_url}; HERMES_HOME={args.home.resolve()}", flush=True)
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    server.serve_forever()


if __name__ == "__main__":
    main()
