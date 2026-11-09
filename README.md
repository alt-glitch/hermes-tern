# Glide

Stop repeating yourself to Hermes. Glide reads your past local sessions, keeps the corrections you
gave ("no, …", "actually, …", "correction: …"), and quotes the ones that match into each new turn.

```
hermes plugins install kvnloo/glide
```

Then, in any Hermes chat (CLI, TUI, desktop or a messaging gateway):

| Command | What it does |
|---|---|
| `/glide` | Shows this machine (CPU, RAM, GPU, local runtimes) and your memory |
| `/glide build` | Reads your last 100 local sessions and keeps the corrections you gave |
| `/glide on` | Before each turn, quotes up to three matching corrections. Current instructions still win |
| `/glide off` | Stops quoting |
| `/glide recall <words>` | Shows what would be quoted for those words |

Nothing happens until you run `/glide build` and `/glide on`.

## How it works

- **Source:** your profile's `state.db`, opened read-only. Only local sessions count (cli, tui,
  desktop, gui, acp, local); cron, delegated and hidden sessions are skipped. Rewound and compressed
  messages are resolved to their newest copy, and a correction you later withdrew is dropped.
- **Memory:** `<profile>/glide/memory.json` (plus a backup and a lock file), written atomically and
  resumable.
- **Recall:** deterministic BM25 over the kept corrections, top three, content words only. No
  embeddings, no model calls.
- **Per turn:** a `pre_llm_call` hook adds the matches as quoted history. If anything fails, the
  turn goes on without it.

Details and the extraction contract: [docs/memory.md](docs/memory.md).

## Frontends that draw cards

Glide also registers four gateway methods, bound to the caller's attached session: `glide.detect`,
`glide.sync`, `glide.enable` and `glide.recall`. A frontend such as
[Tern](https://github.com/alt-glitch/hermes-tern) can call them to show `/glide` as cards with
approve buttons. On a Hermes core without plugin gateway methods they are skipped, and `/glide`
works as text.

## Security and privacy

- **Network:** none. No telemetry, no uploads, no downloads.
- **Reads outside its data:** Hermes' session database, read-only.
- **Commands:** `/glide` (the overview only) runs `nvidia-smi` and, if installed, `z0int doctor --json`,
  each with a 20 s timeout, to describe the machine. Nothing is installed.
- **Writes:** only under `<profile>/glide/`.
- **Background processes:** none.

## Optional: z0intelligence

If [z0intelligence](https://github.com/kvnloo/z0intelligence) is installed, `/glide` reports its
health. Glide works without it.

## Development

```
python -m pytest tests   # with a hermes-agent checkout on PYTHONPATH for tests/test_memory_core.py
```

MIT licensed.
