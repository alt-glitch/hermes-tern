// The lint rule set: the TypeScript rules (docs/conventions.md) as errors on every src/ file, type
// aware through tsconfig.json. scripts/lint-legacy.json lists, per file and rule, the errors the
// code had when the rules came in; `legacy` turns those rules off for those files, so an editor and
// a plain `eslint` show only new errors. scripts/lint.mjs runs `rules` without the overrides and
// holds each legacy count to a ratchet: it only goes down, and a cleaned file leaves the list.
import { readFileSync } from 'node:fs'

import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

const DOCS = 'docs/conventions.md'

/** Where a rule's section in docs/conventions.md is, for a rule's message. */
export const see = anchor => `See ${DOCS}#${anchor}.`

/** The section of docs/conventions.md that explains each rule, by rule id. */
export const SECTIONS = {
  '@typescript-eslint/consistent-type-assertions': 'no-type-assertions',
  '@typescript-eslint/no-non-null-assertion': 'no-non-null-assertions',
  '@typescript-eslint/no-restricted-imports': 'restricted-imports',
  '@typescript-eslint/no-unnecessary-type-assertion': 'no-unnecessary-type-assertions',
  '@typescript-eslint/no-unsafe-argument': 'no-unsafe-any',
  '@typescript-eslint/no-unsafe-member-access': 'no-unsafe-any',
  '@typescript-eslint/switch-exhaustiveness-check': 'exhaustive-switches',
  'no-control-regex': 'control-characters-in-regexps',
  'no-restricted-syntax': 'json-parsing-at-the-boundary'
}

const ZOD = { message: `Import zod/mini, not the zod root. ${see('restricted-imports')}`, name: 'zod' }
const EFFECT = `This package does not use Effect. ${see('restricted-imports')}`

/** The import rule: zod's root and Effect everywhere, plus App outside entry.ts and the tests, and @tui values outside hermes/ and wire/. */
function imports({ app, tui }) {
  const patterns = [{ group: ['effect/*'], message: EFFECT }]

  if (app) {
    patterns.push({
      message: `Only entry.ts (and the tests) import App, the composition root; a module takes the ports it uses. ${see('restricted-imports')}`,
      regex: '(^|/)app/chat(\\.js)?$|^\\./chat(\\.js)?$'
    })
  }

  if (tui) {
    patterns.push({
      allowTypeImports: true,
      group: ['@tui/*'],
      message: `Value imports from the Hermes sources go through hermes/ or wire/; \`import type\` is fine. ${see('restricted-imports')}`
    })
  }

  return ['error', { paths: [ZOD, { message: EFFECT, name: 'effect' }], patterns }]
}

const JSON_PARSE = {
  message: `JSON.parse belongs at a boundary: wire/ decodes, tools/ reads tool details. ${see('json-parsing-at-the-boundary')}`,
  selector: "CallExpression[callee.object.name='JSON'][callee.property.name='parse']"
}

/** The rule set with no legacy overrides: what scripts/lint.mjs runs and counts. */
export const rules = defineConfig([
  { ignores: ['src/vendor/**'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-restricted-imports': imports({ app: true, tui: true }),
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
      'no-control-regex': 'error',
      'no-restricted-syntax': ['error', JSON_PARSE]
    }
  },
  { files: ['src/entry.ts', 'src/__tests__/**'], rules: { '@typescript-eslint/no-restricted-imports': imports({ app: false, tui: true }) } },
  {
    files: ['src/hermes/**', 'src/wire/**'],
    rules: { '@typescript-eslint/no-restricted-imports': imports({ app: true, tui: false }) }
  },
  {
    files: ['src/wire/**', 'src/core/ids.ts', 'src/gateway/dispatch.ts'],
    rules: { '@typescript-eslint/consistent-type-assertions': 'off' }
  },
  { files: ['src/wire/**', 'src/tools/**'], rules: { 'no-restricted-syntax': 'off' } }
])

/** The legacy list: `{ "<file> <rule>": count }`, the errors a file had when the rules came in. */
export const LEGACY = JSON.parse(readFileSync(new URL('./scripts/lint-legacy.json', import.meta.url), 'utf8'))

/** One override per legacy file, turning its legacy rules off. */
export function legacy(list) {
  const byFile = new Map()

  for (const key of Object.keys(list)) {
    const [file, rule] = key.split(' ')
    byFile.set(file, { ...byFile.get(file), [rule]: 'off' })
  }

  return [...byFile].map(([file, off]) => ({ files: [file], rules: off }))
}

export default [...rules, ...legacy(LEGACY)]
