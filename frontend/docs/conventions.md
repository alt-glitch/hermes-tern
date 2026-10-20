# TypeScript conventions

`bun run lint` (part of `bun run check`) holds `src/` to these rules. `eslint.config.js` sets them
as errors, type aware through `tsconfig.json`; `src/vendor/` keeps its upstream code and is not
linted. Each lint message names the section here that explains it.

## The legacy list

`scripts/lint-legacy.json` counts, per file and rule, the errors the code had when the rules came
in. The config turns those rules off for those files, so an editor and a plain `eslint` show only
new errors; `scripts/lint.mjs` runs every rule everywhere and checks the counts:

- A file and rule with no entry may have no errors.
- A count only goes down. When a fix lowers one, `bun run lint -- --update` writes the lower count
  and drops the entries a cleaned file no longer needs.
- The list may not gain an entry or raise a count against HEAD, so new code adds no debt. Code that
  moves to a new file is cleaned on the way.

## No type assertions

`@typescript-eslint/consistent-type-assertions` (`assertionStyle: 'never'`): no `x as T` and no
`<T>x`. A cast tells the compiler to stop checking, and the wrong shape then fails far from where
it came in. Narrow instead: a discriminant `switch`, `in`, `typeof` or `instanceof`, a type guard
that checks what it claims, or `satisfies` to check a literal without widening it. `as const` is
fine.

Casts belong where data crosses in, after it is checked: `src/wire/**` (decoders),
`src/core/ids.ts` (brands) and `src/gateway/dispatch.ts` (the event table) may use them.

## No non-null assertions

`@typescript-eslint/no-non-null-assertion`: no `x!`. Handle the missing case (`if (!x) return`,
`?.`, `??`), or make the type say the value is there: `NonEmpty<T>` from `core/assert.ts` for a
list with a first item, named regexp groups for a match.

## No unnecessary type assertions

`@typescript-eslint/no-unnecessary-type-assertion`: a cast or `!` that does not change the type is
noise, and it hides the real assertions among the dead ones. Remove it.

## No unsafe any

`@typescript-eslint/no-unsafe-member-access` and `no-unsafe-argument`: no reading fields of an
`any` value and no passing one where a type is expected. `any` turns the checker off for
everything it touches. Type external data as `unknown` and parse it (`record()` from
`wire/json.ts`, or a `zod/mini` schema at a real boundary) into a named type.

Gateway requests go through `rpc(gw, method, params)` in `wire/rpc.ts`, not `gw.request<T>()`:
the method names its params and its result from the generated contract (the classic result, or
the shared gateway's as the client adapts it). A shape that differs between gateway versions
(`process.list` rows, a `session.usage` tick, the `pending_submissions` FIFO) is read with
`rpcParsed()` or a schema in `wire/schemas.ts`.

## Exhaustive switches

`@typescript-eslint/switch-exhaustiveness-check`: a `switch` over a union with no `default` must
handle every member, so a new member fails to compile where it needs a case. A `default` counts as
handling the rest; when the switch should cover every member, end it with
`default: assertNever(x)` from `core/assert.ts` so the compiler still checks.

## Restricted imports

`@typescript-eslint/no-restricted-imports`:

- `zod`: import `zod/mini` only. The bundle is committed and unminified, and the mini API is the
  small one.
- `effect` and `effect/*`: this package does not use Effect. Brands, tagged unions, the Epoch
  ticket and disposables are plain TypeScript (the bundle size and per-pane startup decided it).
- `app.js` from below `src/`: only the root modules import App. A module declares the ports it
  uses (`Pick<ChatPorts, …>`, src/app/ports.ts) and App passes itself in.
- Value imports from `@tui/*` outside `src/hermes/**` and `src/wire/**`: the Hermes sources move
  with `hermes update`, so their runtime code comes in through those two directories.
  `import type` from `@tui/*` is fine anywhere.

## JSON parsing at the boundary

`no-restricted-syntax`: `JSON.parse` only in `src/wire/**` (decoders for the gateway, files and
child processes) and `src/tools/**` (tool details). Elsewhere, call a decoder that returns a typed
value, so a module never holds the `any` that `JSON.parse` returns.

## Control characters in regexps

`no-control-regex`: a control character in a regexp (`\x1b`, `\x07`) is usually a typo. Where
stripping terminal escapes is the point, disable the rule for that line and say so (see below).

## Suppressions

`scripts/check-suppressions.mjs` fails on an `eslint-disable` comment (any form) or a
`@ts-expect-error`, `@ts-ignore` or `@ts-nocheck` directive with no reason after ` -- `:

```ts
// eslint-disable-next-line no-control-regex -- terminal escapes are what this strips
```

A cast that is the boundary itself says `-- boundary: <what crosses>`. eslint also reports a
disable comment that disables nothing.
