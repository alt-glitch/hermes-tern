# Glide local corrections memory

This is the independent memory prerequisite for [#209](https://github.com/kvnloo/hermes-tern/issues/209).
The repository root is the plugin package, so its Python module is
`glide/`. It adds no dependencies, registration, slash command, model call, or prompt hook.
The onboarding and per-turn host integration remain separate work.

## Calling it from the plugin

```python
from .glide import GlideMemory, MemoryNotReady

memory = GlideMemory()  # Create within the current profile's routed context.
progress = memory.sync(selected_session_ids, batch_size=128, max_batches=1)
while not progress.complete:
    progress = memory.sync(selected_session_ids, batch_size=128, max_batches=1)

matches = memory.search("parser checks")  # At most three positive BM25 matches.
local_excerpt = memory.context("parser checks", max_chars=2048)
```

The caller must obtain the user's session selection first; there is no implicit
scan of every session. Pass 1–100 exact session IDs. Only those IDs are read;
compression descendants are not silently added. An explicit list can contain a
session with no messages or a since-deleted session, yielding an empty contribution.

Construction lazily calls Hermes' `hermes_constants.get_hermes_home()`,
which honors the routed context override before the environment or platform default.
One instance stays bound to that profile; create a new instance when routing changes.
An explicit profile path is supported for local callers and tests.

All derived files are under `<profile>/glide/`: `memory.json`,
`memory.json.bak` and `.memory.lock`. The source is
`<profile>/state.db`, opened with an escaped `mode=ro` URI and
`query_only`. A live WAL remains visible. Missing or incompatible sources raise
`SourceError`; the module never creates or migrates Hermes' database.

## Extraction contract

The schema and content encoding are grounded in the runtime lock
[22063fc099ec9ad8357d7f8f6e6248a0400680d3](https://github.com/kvnloo/hermes-agent/tree/22063fc099ec9ad8357d7f8f6e6248a0400680d3):

- [sessions/messages DDL](https://github.com/kvnloo/hermes-agent/blob/22063fc099ec9ad8357d7f8f6e6248a0400680d3/hermes_state_common.py).
- [content encoding, edits, rewind and compaction](https://github.com/kvnloo/hermes-agent/blob/22063fc099ec9ad8357d7f8f6e6248a0400680d3/hermes_state_messages.py).
- [profile resolver](https://github.com/kvnloo/hermes-agent/blob/22063fc099ec9ad8357d7f8f6e6248a0400680d3/hermes_constants.py).

Selected local sessions must use one of the existing frontend's local sources:
acp, cli, desktop, gui, local or tui. Hidden sessions, delegated sessions, and
unclassified child sessions are excluded. Explicit branch/reset children and
compression continuations can contribute when selected.

Only user-role rows that are active or retained as compacted history qualify.
Summary carriers, hidden/internal notices, model-only rows and undrained queued
prompts are excluded. Malformed or oversized metadata fails closed. Session
selection matters: the schema has no per-message field proving a human owner.

Extraction is deliberately conservative and deterministic. A text must begin
with `Correction:`, `Actually,` or `No,` (case-insensitive).
The prefix is removed and whitespace normalized; the remaining wording is retained
whole. It does not infer an unstated preference, rewrite a rule, or semantically
resolve contradictions. Unsignalled corrections require a later extraction policy.

Hermes' NUL-prefixed `\x00json:` content is decoded exactly once.
Only text parts are used; media URLs and arbitrary JSON fields are ignored.
BLOB projection bounds avoid SQLite's NUL-terminated TEXT length behavior.
Raw content is capped at 16 KiB, metadata at 4 KiB and each extracted rule at
1,024 characters. Oversized rules are omitted, never cut before a qualification.

## Atomic refresh and resume

Hermes edits and deactivates existing IDs. Every sync first streams a digest of
the selected user rows and the session fields affecting extraction. That pass and
the indexing pass share one read-only SQLite transaction.

Each batch atomically checkpoints its digest, selection, cursor, records and
completion flag together. A later call resumes only if both selection and digest
match. An edit, deletion, source replacement, eligibility change or changed
selection restarts the scan. Assistant/tool messages do not invalidate the digest.

A process lock serializes readers and writers. Same-directory private temporary
files are flushed, fsynced and replaced atomically; the containing directory is
fsynced on POSIX. The previous valid checkpoint is retained as a backup (it can contain an earlier selection). Checksums,
types, bounds, scope and record ordering are validated before reuse. Corrupt state
recovers from a valid backup or rebuilds from the selected source. Unsupported
versions raise `StateVersionError` and preserve the files.

Search recomputes the digest and raises `MemoryNotReady` for incomplete or
changed state, or when recovery requires an explicit selection. Sync again and retry. A partial rebuild is never served. The digest
requires O(N) work over selected user rows on each sync/search, while source reads
remain bounded in memory. It is a snapshot check, not a lock against a source edit
after the read transaction finishes.

## Retrieval and privacy

BM25 uses fixed k1=1.5 and b=0.75 with positive IDF, Unicode-normalized tokens,
unique query terms and deterministic lexical/source tie breaking. Exact normalized
duplicates count once; the newest occurrence supplies provenance. The store retains
the newest 4,096 unique corrections and reports `SyncResult.limited` if capped.

Queries are limited to 512 characters. `search` returns up to three positive
matches with session/message provenance. `context` defaults to 2,048 characters
and enforces a 4,096-character ceiling including framing and JSON quoting. It omits
whole entries that do not fit. This is a character budget, not a token estimate.

The module performs no networking or subprocess execution, logs no transcript
content, and uses no embeddings or model services. Everything remains local.
Returning an excerpt does not authorize a host to send it to a remote model; the
future host must enforce the selected local-only policy. Remove derived files
only after all users of the store have stopped if a complete local reset is needed.

## Verification

```sh
python -m pytest -q tests/test_glide_memory.py
python -m pytest -q
hermes plugins validate .
```

Tests use synthetic workflow text in real temporary SQLite databases, the existing
pytest bootstrap and a network/subprocess prohibition. They cover source eligibility,
structured content, restart, mutation invalidation, atomic interruption, corruption,
profile isolation, WAL/read-only behavior, ranking and bounds.

All commands and tests were **UNRUN** when this change was authored through the
GitHub connector. The fork's existing checks workflow can provide execution evidence;
no runtime or performance claim is made here.
