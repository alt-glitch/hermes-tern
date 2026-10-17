"""A loopback OpenAI-compatible model for driving `hermes tern` without credentials.

    python lab/fake_model.py --home DIR [--port N]

Writes a disposable HERMES_HOME at DIR (config pointing at this server, the plugin enabled,
first-run prompts answered) and then serves until killed. What the model does is picked by
the user's prompt, so one home covers every flow:

    "approve"   -> a terminal call Hermes flags as dangerous (approval sheet)
    "clarify"   -> a clarify call with choices (clarify sheet)
    "tool"      -> a harmless terminal call (tool card)
    "steps"     -> four calls in a row (commands, a read, a search), then an answer
    "work…"     -> (at the start) a turn like a real one: reasoning, short notes and tool calls
                   in rounds (commands, reads, a search, a slow command), then a long answer
    "script"    -> a heredoc script with sections and long output, run alone
    "slow"      -> one 8-second command, long enough to queue or steer a message
    "delegate…" -> (at the start) a delegate_task batch of three subagents, each running two slow
                   terminal calls before a slowly streamed answer
    "background…" -> (at the start) a 90 s ticking background process that notifies on exit
    "watch…"    -> (at the start) a 2 min ticking background process watching for "tick 10"
    "errands…"  -> (at the start) a four-item todo list worked through over slow steps
    "connector…" -> (at the start) a tool search, a two-app connector batch and one connector call
    "pr…"       -> (at the start) links a real public PR (link_pull_request)
    "cron…"     -> (at the start) two cron jobs: a 30 min digest and a 15 min page monitor
    anything else -> a streamed markdown reply
"""

import argparse
import json
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

SUBAGENT_REPLY = """Finished the delegated task.

- ran two terminal steps
- found nothing alarming

The parent can take it from here.
"""


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


def _subagent_calls(messages: list[dict]) -> list[dict] | None:
    """A subagent's next move: one slow terminal step per earlier tool result, then the answer."""
    done = sum(1 for m in messages if m.get("role") == "tool")
    if done >= len(SUBAGENT_STEPS):
        return None
    return [_call("terminal", {"command": SUBAGENT_STEPS[done]}, f"call-step{done}")]


def _calls(prompt: str, target: Path) -> list[dict] | None:
    words = prompt.lower()
    # Only a prompt that starts with it: the parent's completion notice quotes the delegation and
    # would otherwise dispatch again, forever.
    if words.lstrip().startswith("delegate"):
        return [_call("delegate_task", {"tasks": [{"goal": g} for g in SUBAGENT_GOALS]})]
    if words.lstrip().startswith("slow"):
        return [_call("terminal", {"command": "sleep 8 && echo slept"})]
    if words.lstrip().startswith("background"):
        return [_call("terminal", {"command": TICKS.format(n=90), "background": True, "notify_on_complete": True})]
    if words.lstrip().startswith("watch"):
        # `notify` is the advertised flag (tools/terminal_tool.py): a list watches for those lines.
        return [_call("terminal", {"command": TICKS.format(n=120), "background": True, "notify": ["tick 10"]})]
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
    if words.lstrip().startswith("pr"):
        # A real public PR, linked the way an agent links one it opened (through the tool_call bridge
        # in case Tool Search defers the plugin's tools).
        return [_call("tool_call", {"name": "link_pull_request", "arguments": {
            "url": "https://github.com/alt-glitch/hermes-tern/pull/22"}}, "call-link")]
    if words.lstrip().startswith("cron"):
        # cronjob_manage is a deferred tool: the model reaches it through the tool_call bridge.
        return [
            _call("tool_call", {"name": "cronjob_manage", "arguments": {
                "action": "create", "name": "lab digest", "schedule": "every 30m", "prompt": "Summarise the lab notes."}}, "call-cron"),
            _call("tool_call", {"name": "cronjob_manage", "arguments": {
                "action": "create", "name": "lab page watch", "schedule": "every 15m",
                "prompt": "Say what changed on the page.", "monitor": "https://example.com"}}, "call-monitor"),
        ]
    if words.lstrip().startswith("script"):
        return [_call("terminal", {"command": SCRIPT})]
    if "approve" in words:
        target.mkdir(exist_ok=True)
        return [_call("terminal", {"command": f"rm -rf -- {target}"})]
    if "clarify" in words:
        return [_call("clarify", {"questions": [{"question": "Which colour?", "choices": ["red", "green", "blue"]}]})]
    if "tool" in words:
        return [_call("terminal", {"command": "echo tool-ok && ls"})]
    return None


def _call(name: str, arguments: dict, call_id: str = "") -> dict:
    return {"id": call_id or f"call-{name}", "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}


class Server(ThreadingHTTPServer):
    target: Path


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
        if isinstance(system, str) and SUBAGENT_MARKER in system:
            calls = _subagent_calls(messages)
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
            content = "Done: the tool returned." if answered else (None if calls else REPLY)
            delay = 0.0
        if request.get("stream"):
            self._stream(content, calls, delay)
        else:
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
