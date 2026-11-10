# Glide local corrections memory

The memory layer under `/glide` (`memory.py`, `source.py`, `storage.py`). It makes no model
calls, adds no dependencies and never writes Hermes' database. `core.py` wires it to the
`/glide` command and the `pre_llm_call` hook.

## Calling it from the plugin

```python
from . import GlideMemory, MemoryNotReady

memory = GlideMemory()  # Create within the current profile's routed context.
progress = memory.sync(selected_session_ids, batch_size=128, max_batches=1)
while not progress.complete:
    progress = memory.sync(selected_session_ids, batch_size=128, max_batches=1)

matches = memory.search("parser checks")  # At most three positive BM25 matches.
local_excerpt = memory.context("parser checks", max_chars=2048)
```

The caller must obtain the user's session selection first; there is no implicit
scan of every session. Pass 1–100 exact session IDs. Only those IDs contribute
message content; bounded ancestry metadata is read to resolve compression copies.
Compression descendants are not silently added. Select one continuation path per
compression root: incomparable sibling continuations raise `SourceError`, as do
cyclic or overlong (more than 100 sessions) ancestry paths. An explicit list can
contain a session with no messages or a since-deleted session, yielding an empty contribution.

Construction lazily calls Hermes' `hermes_constants.get_hermes_home()`,
which honors the routed context override before the environment or platform default.
One instance stays bound to that profile; create a new instance when routing changes.
An explicit profile path is supported for local callers and tests.

Persistent memory state is under `<profile>/glide/`: `memory.json`,
`memory.json.bak` and `.memory.lock`. The source is
`<profile>/state.db`, opened with an escaped `mode=ro` URI and
`query_only`. A live WAL remains visible. Missing or incompatible sources raise
`SourceError`; the module never creates or migrates Hermes' database.

## Extraction contract

The schema and content encoding are grounded in the runtime lock
[22063fc099ec9ad8357d7f8f6e6248a0400680d3](https://github.com/kvnloo/hermes-agent/tree/22063fc099ec9ad8357d7f8f6e6248a0400680d3):

- [sessions/messages DDL](https://github.com/kvnloo/hermes-agent/blob/22063fc099ec9ad8357d7f8f6e6248a0400680d3/hermes_state_common.py).
- [durable UIDs and merged-message witnesses](https://github.com/kvnloo/hermes-agent/blob/22063fc099ec9ad8357d7f8f6e6248a0400680d3/agent/message_metadata.py).
- [content encoding, edits, rewind and compaction](https://github.com/kvnloo/hermes-agent/blob/22063fc099ec9ad8357d7f8f6e6248a0400680d3/hermes_state_messages.py).
- [profile resolver](https://github.com/kvnloo/hermes-agent/blob/22063fc099ec9ad8357d7f8f6e6248a0400680d3/hermes_constants.py).

Selected local sessions must use one of the existing frontend's local sources:
acp, cli, desktop, gui, local or tui. Hidden sessions, delegated sessions, and
unclassified child sessions are excluded. Explicit branch/reset children and
compression continuations can contribute when selected.

Before extraction, the newest physical generation of each logical user message
wins, including inactive generations. Durable `message_uid` identifies copies within
a verified compression lineage; explicit branch/reset conversations and excluded
sessions stay separate. A rewound newest copy suppresses its older active or
compacted copies. An older superseded copy does not suppress a newer live one.
The parent binding of branch/reset markers is checked at each ancestry hop.

A merged user turn keeps its first constituent's UID and carries the others in
`absorbed_message_uids`. The newest direct or absorbed witness determines whether
an older constituent is withdrawn. This state resolution is separate from choosing
the constituent's source text: a live composite beginning with an ordinary request
does not hide a retained correction that follows it. Rewinding that composite
suppresses the older correction, while a newer live witness supersedes an older
composite withdrawal. The original row must still qualify as active or compacted
history; a live witness alone does not make withdrawn source text extractable.
Witnesses never merge distinct UIDs by wording or cross the selected lineage.
Hermes carries flattened constituent lists through nested merges; the reader does
not infer extra relationships from missing witnesses.

The optional witness column is treated as empty on legacy schemas. NULL, an empty
stored value and `[]` represent no absorbed UIDs. A present value must be a complete
JSON array of at most 128 nonempty UTF-8 string UIDs, within 4 KiB of stored bytes;
duplicates are deduplicated, and self-witnesses are harmless. Malformed, unencodable
or oversized witnesses in selected user rows from eligible sessions raise `SourceError` before
retrieval or checkpoint publication. They are never truncated or silently treated
as empty, which could hide a withdrawal. Excluded sessions contribute no witnesses.

For missing/empty legacy UIDs, exact stored content, timestamp and tool identity
provide a fallback. A legacy row adopts a unique matching durable UID; ambiguous
legacy rows are omitted. Distinct nonempty UIDs are never merged by wording or
timestamp. UIDs larger than 4 KiB are omitted rather than compared by a truncated
prefix. Already-migrated historical copies with different nonempty UIDs, or
legacy copies whose identity fields changed, cannot safely be inferred as copies.

Only resolved user-role rows that are active or retained as compacted history qualify.
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
all selected user generations (including withdrawals), their identity fields,
complete bounded absorbed-UID witnesses and resolved ancestry paths. Policy changes
also invalidate old checkpoints. That pass and
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
requires O(N) work over selected user rows on each sync/search. A sync also ranks
generations in SQLite once, with a streaming cursor across batches; Python holds
only a batch, one lookahead row and bounded ancestry metadata. SQLite may use
temporary sorting storage. Large-profile performance has not been measured.
This is a snapshot check, not a lock against a source edit after the read
transaction finishes.

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
python -m pytest -q tests/tests/test_memory.py
python -m pytest -q tests/test_glide_memory_core.py  # Requires the CI's Hermes core environment.
python -m pytest -q
hermes plugins validate .
```

Tests use synthetic workflow text in real temporary SQLite databases, the existing
pytest bootstrap and a network/subprocess prohibition. They cover source eligibility,
structured content, compression/rewind generations, merged constituent withdrawals,
witness-only edits during complete/partial scans, newer live witnesses, bounded witness decoding,
legacy UID transitions, fork and selection boundaries, restart, mutation invalidation,
atomic interruption, corruption,
profile isolation, WAL/read-only behavior, ranking and bounds. The separate core integration
regression persists synthetic turns with Hermes' real SessionDB, publishes a compression
child and rewinds its composite through the real APIs. It uses the existing pinned core test
environment; the standalone SQLite fixture suite remains independent of core imports.

All commands and tests were **UNRUN** when this change was authored through the
GitHub connector. The fork's existing checks workflow can provide execution evidence;
no runtime or performance claim is made here.
