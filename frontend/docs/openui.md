# OpenUI prepared visual previews in hermes-tern

This downstream feature preserves the reviewed Hermes OpenUI experiment *as source*
inside the installed plugin, with its original validator, static OpenUI parser
adapter, fingerprint inputs, fixed Luau/CSS route and tests. It does not change
Hermes' gateway or Tern session/approval authority. It renders **read-only
summaries**, not generated executable code, model output or publication receipts.

## Packaged layout and runtime boundary

- `frontend/openui/openui-preview/src/bundle.mjs`: original strict JSON
  validator, bundle/scope assertions, byte caps and current-source fingerprints.
- `frontend/openui/openui-generation/src/`: original bounded
  `@openuidev/lang-core@0.3.1` compiler adapter, catalog and static-program
  guard. The exact donor package lock and `.npmrc` ship alongside these files;
  the root Bun workspace lock mirrors their exact npm integrity records.
- `frontend/openui/openui-preview/tern/`: the reviewed `host.luau`,
  `window.luau`, `visual.css` and `plugin.toml`. Their actual bytes are
  fingerprint inputs. **Files are shipped, not installed into Tern.**
- `frontend/openui/prepare.mjs`: explicit **prepare-only**, `--json`
  entrypoint. It sets `OPENUI_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1`
  before importing the original `openui-preview/cli.mjs`. It neither
  installs dependencies nor runs a renderer, network request or model.

The validator in `frontend/src/wire/openui.ts` resolves the tracked
`frontend/openui/` directory relative to its own source module in tests
(`src/wire/`) or compiled ESM bundle (`dist/entry.js`). The normal
`frontend/dist/entry.js` output and the packaged source tree **must remain
siblings under the same installed `frontend/` directory**. The package is
not replaced by generated `dist/` code. `HERMES_PYTHON_SRC_ROOT`, the
current working directory and a donor checkout are not consulted.

Every opened candidate is re-read with a bounded regular-file/strict-UTF-8
read, then the **original** validator checks its exact identity, catalog
hash, generation contract, artifact/document and current fingerprints.
`fingerprints()` hashes the four fixed renderer files, four preview modules,
five generation modules and the generation lockfile. Missing or drifted files
fail closed. The separate `HERMES_SRC` used to build the main frontend's
gateway client remains pinned to the locked upstream Hermes runtime
`22063fc099ec9ad8357d7f8f6e6248a0400680d3`; it is **not** an OpenUI
source prerequisite, and that upstream runtime does not contain this preview.

## Prepare a candidate explicitly

For **contributors and CI**, the supported clean-install path is the root
Bun workspace. The root manifest includes `openui/openui-generation` as a
self-contained workspace; `bun.lock` pins exactly the donor's
`@openuidev/lang-core@0.3.1`, `zod@4.0.0` and `ci-info@4.4.0`
checksums, while the frontend keeps its existing `zod@4.4.3`.
This prevents the generator from accidentally resolving the frontend's
Zod or relying on an undeclared nested `npm ci`.

```sh
cd frontend
HERMES_SRC=/absolute/path/to/locked-upstream-hermes node scripts/hermes-src.mjs
OPENUI_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 bun install --frozen-lockfile
bun run check
```

The Hermes source checkout above is the existing pinned gateway/build input,
**not** an OpenUI donor checkout. The parser's install script is not trusted
by the frontend, and both telemetry-disable flags are set for installs.
No dependencies are installed on render, preview, or test execution.

For **prebuilt plugin users** who did not run the root frontend development
install and want to **explicitly prepare** a new candidate, a separate
preparation-only install remains possible:

```sh
cd frontend
OPENUI_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 npm ci --prefix openui/openui-generation --ignore-scripts --no-audit --no-fund --workspaces=false
```

That optional prebuilt preparation command is **not** a contributor/CI
prerequisite and must never be invoked automatically by `/visual`, a render,
or a test. Missing parser dependencies fail closed. The donor npm lock and
all fingerprint inputs remain unmodified.

1. In a running `hermes tern` session, type `/visual`. Copy its exact JSON
   session/branch scope (for example `["stored-id","main"]`).
2. Provide a complete `.openui` program and a host-approved version-1
   repository document on the **frontend host filesystem**. For an inert
   sample, the shipped `openui-generation/fixtures/explorer.openui` and
   `openui-preview/fixtures/repository.json` contain synthetic data.
3. Run the explicit local CLI through the terminal tool, substituting the
   session scope and an external absolute output directory:

   ```sh
   cd /absolute/path/to/hermes-tern/frontend
   node openui/prepare.mjs prepare \
     openui/openui-generation/fixtures/explorer.openui \
     openui/openui-preview/fixtures/repository.json \
     '["stored-id","main"]' /absolute/output-directory --json
   ```
4. The successful invocation prints exactly one full
   `{"kind":"hermes.visual.candidate","version":1,"id":"…","path":"…","scope":"…"}`
   notice. Reopen `/visual` and select it with arrows/Enter or click, or
   explicitly type `/visual /absolute/path/to/file.hvisual.json`. Escape
   cancels.

The CLI has **no hidden install or generator call**. It parses the supplied
complete source with the real pinned OpenUI parser and independent static
guards, binds the approved repository document to the scope and immutable
source fingerprints, then writes a content-addressed read-only
`.hvisual.json` outside the plugin/source directory.

Discovery accepts only successful completed terminal results, within
128 transcript entries, 512 blocks, 64 KiB aggregate JSON parse work and
12 newest unique candidates. Notices are untrusted pointers; a reported
candidate ID must match the validated file. Session/branch/transcript changes
expire displayed sheets. File links reopen current bytes; they are **not**
atomic, approved revisions.

## Intent boards (`ephemeral-intent/v1`)

The same pipeline compiles the ephemeral-ui intent kit as a native board: declared intent,
contract gates, work slices, proof receipts, decision mix, token value, context flow and runtime
health. The catalog is `openui-generation/src/intent.mjs` (root
`IntentBoard(snapshotId, sections)`, 1–8 distinct sections, the only argument being
`DecisionMix(by: "execution" | "providers" | "status")`); its pinned definition
`fixtures/ephemeral-intent.v1.json` is checked signature for signature against ephemeral-ui's
`integration/openui/ephemeral-intent.v1.json`. **The model selects sections; the host document
owns every value.** `openui-preview/src/intent-document.mjs` validates that document field by
field (64 KiB, 12-item lists, enums, no control characters) and the Luau renderer checks it again.
No section approves, executes or publishes; approval stays with the host's AODL path.

```sh
cd /absolute/path/to/hermes-tern/frontend
node openui/prepare.mjs prepare-intent \
  openui/openui-generation/fixtures/intent.openui \
  openui/openui-preview/fixtures/intent-board.json \
  '["stored-id","main"]' /absolute/output-directory --json
```

A real host document comes from ephemeral-ui's `tools/openui-intent-doc.mjs`. The shipped
`fixtures/intent-board.json` is synthetic. `/visual` lists and opens an intent candidate like a
repository one; its sheet names the chosen sections instead of an initial mode.

## Optional native route, kept separate

The fixed Tern `hermes-openui` file route is present at
`frontend/openui/openui-preview/tern/` but **is not linked or enabled** by
the frontend. On a disposable Tern host, an operator may independently
review the files and explicitly run
`tern plugin link /absolute/path/to/hermes-tern/frontend/openui/openui-preview/tern`.
The narrow route handles `*.hvisual.json`; no chat overlay, discovery or
frontend build auto-installs it. Its working native pixels and control
protocol must still be established in a live authenticated Tern window.
A file link without that enabled route is not evidence of a rendered preview.

No publication, automatic renderer install, model request while rendering,
generated Lua/JS execution, capture approval or transcript insertion is added.

## OMP exact-head verification

Use the real locked NousResearch checkout only as `HERMES_SRC` for the
regular frontend's existing gateway/client build. No donor checkout or
`HERMES_PYTHON_SRC_ROOT` variable is used for OpenUI.

```sh
cd frontend
HERMES_SRC=/absolute/path/to/locked-upstream-hermes node scripts/hermes-src.mjs
OPENUI_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 bun install --frozen-lockfile
bun run check
bun run test src/__tests__/openuiInstall.test.ts src/__tests__/openuiPackaged.test.ts src/__tests__/visuals.test.ts src/__tests__/visual-discovery.test.ts src/__tests__/visualOverlay.test.ts
OPENUI_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 npm test --prefix openui/openui-generation --workspaces=false
OPENUI_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 npm test --prefix openui/openui-preview --workspaces=false
OPENUI_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 node --test openui/openui-preview/test/integration.mjs
bun run bundle
```

The frozen-workspace regression checks the root/child manifest, donor integrity pins
and generation-local Zod resolution; the unconditional packaged CLI suite
executes the real parser after the normal install. No nested npm step is
needed in CI. The new real-path suite exercises the shipped CLI with both telemetry
variables absent in its subprocess environment, strict validation, Tern SDK
native JSX, changed renderer/parser fingerprints, wrong scope, swapped notice
ID, malformed data/UTF-8, actual file byte bounds and cancellation. The
donor's retained Node tests additionally cover static-program rejection,
catalog bounds, capture and lifecycle contracts. No tests or live Tern window
ran through the GitHub connector; OMP must record exact-head command output.
After the MBP gate, run isolated authenticated native Tern smoke separately
(including `/visual` discovery, branch/session expiry and the explicitly
linked optional route). Mock Tern and Lua checks are not pixel verification.

## Provenance and licenses

Preserved without modification from
`kvnloo/hermes-agent@724b2aaec5981eb264f65923f72858faff27bb5b`,
`ui-tsp/experiments/openui-preview/` and
`ui-tsp/experiments/openui-generation/`, including the fixtures, tests,
original README files and MIT `frontend/openui/LICENSE` (Nous Research).
The parser is the pinned `@openuidev/lang-core@0.3.1` by Thesys/OpenUI
contributors (MIT; installed with its locked dependencies), not a copied
replacement. Native protocol credit remains with Can Bölük, Stencil Labs,
Tern/OMP and Hermes contributors; the preview/verify/publish reference is
from bmdavis419 and T3 Code contributors. This is downstream integration,
not a claim of endorsement or native-pixel acceptance.

See the donor's source PRs
[#456](https://github.com/kvnloo/hermes-agent/pull/456),
[#457](https://github.com/kvnloo/hermes-agent/pull/457),
[#460](https://github.com/kvnloo/hermes-agent/pull/460),
[#461](https://github.com/kvnloo/hermes-agent/pull/461),
[#464](https://github.com/kvnloo/hermes-agent/pull/464) and
[#466](https://github.com/kvnloo/hermes-agent/pull/466).
