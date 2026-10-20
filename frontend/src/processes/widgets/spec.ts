// The declarative spec a cheap model writes once per background process: rules that pull
// numbers and words out of its output lines, and the blocks that draw them. Validation is what
// lets a spec drive a chart unattended: every pattern compiles (to a linear-time RegExp where
// Node has the engine), every field a block reads is fed by a rule, and the rules match the
// samples the author saw. Ported from omp (packages/coding-agent/src/job-widgets/spec.ts); its
// Rust `LineMatcher` is a list of RegExps here, and Hermes' processes have one source, `out`.

import { setFlagsFromString } from 'node:v8'

import type { Tone } from '@stencil-hq/tern'

import type { Better } from './types.js'

/** How a field's values reduce to one number. */
export type Agg = 'last' | 'first' | 'min' | 'max' | 'mean' | 'sum' | 'count' | 'rate' | 'delta' | 'change'

export const AGGS: readonly Agg[] = ['last', 'first', 'min', 'max', 'mean', 'sum', 'count', 'rate', 'delta', 'change']

export const TONES: readonly Tone[] = ['neutral', 'accent', 'info', 'success', 'warning', 'error', 'pending', 'muted', 'user']

/**
 * One line-matching rule. Every named group but `key` feeds the field of the same name with
 * its capture: a number, or text for the `text` group (and for a capture holding no number).
 */
export interface Rule {
  /** Source id (`out`), `*` for all, a trailing `*` for a prefix. */
  from: string
  /** A regex with named groups, matched per line. */
  match: string
  /** Group splitting every field of the rule into one series per key; not a field itself. */
  key?: string
  /** Group whose capture is kept as text, not parsed as a number. */
  text?: string
  /** Field counting the rule's matches. */
  count?: string
  /** Multiplies every number the rule captures. */
  scale?: number
}

export interface RuleField {
  field: string
  text: boolean
  count: boolean
}

/** A number derived from one field. */
export interface ValueRef {
  field: string
  key?: string
  agg: Agg
  unit?: string
  digits?: number
  better?: Better
}

export interface SparkSpec {
  kind: 'spark'
  field: string
  key?: string
  label: string
  unit?: string
  better?: Better
  target?: number
  targetLabel?: string
  min?: number
  max?: number
}

export interface BarsSpec {
  kind: 'bars'
  field: string
  agg: Agg
  label: string
  unit?: string
  max?: number
  better?: Better
}

export interface MeterSpec {
  kind: 'meter'
  field: string
  agg: Agg
  key?: string
  total: number | ValueRef
  label: string
  unit?: string
}

export interface StatSpec {
  kind: 'stat'
  items: (ValueRef & { label: string })[]
}

export interface GridSpec {
  kind: 'grid'
  field: string
  label: string
  /** Tone by the key's latest text: case-insensitive substring, first listed wins. */
  tones: Record<string, Tone>
}

export interface TextSpec {
  kind: 'text'
  field: string
}

export type BlockSpec = SparkSpec | BarsSpec | MeterSpec | StatSpec | GridSpec | TextSpec

export interface Spec {
  /** What is watched, ≤ 48 chars. */
  title: string
  /** 1–12. */
  rules: Rule[]
  /** 1–4; the first is the primary block compact views show. */
  blocks: BlockSpec[]
  headline?: ValueRef & { label?: string }
  /** Field whose latest captured text is the stage line. */
  stage?: string
}

export const MAX_TITLE_CHARS = 48
const MAX_RULES = 12
const MAX_BLOCKS = 4
const MAX_STAT_ITEMS = 4
const MAX_PATTERN_CHARS = 400
const MAX_LABEL_CHARS = 48
const MAX_UNIT_CHARS = 12
const MAX_GRID_TONES = 12
const FIELD_NAME = /^[a-z][a-z0-9_]{0,23}$/
const GROUP_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/
const SOURCE_ID = /^(?:\*|[A-Za-z0-9_:.-]{1,64}\*?)$/
/** Named groups in both spellings: `(?P<name>…)` (Python, Rust) and `(?<name>…)`. */
const NAMED_GROUP = /\(\?P?<([A-Za-z_][A-Za-z0-9_]*)>/g

const STRING = { type: 'string' } as const
const NUMBER = { type: 'number' } as const
const BETTER = { enum: ['higher', 'lower'] } as const
const VALUE_REF_SCHEMA = {
  properties: {
    agg: { enum: AGGS },
    better: BETTER,
    digits: { type: 'integer' },
    field: STRING,
    key: STRING,
    label: STRING,
    unit: STRING
  },
  required: ['field', 'agg'],
  type: 'object'
} as const

/**
 * JSON schema of a {@link Spec}, the parameters of the `respond` tool the author calls. Bare on
 * purpose (shapes and enums): the system prompt documents every property. Nothing is required
 * at the top, since a `{"skip": …}` answer declines to chart; validation enforces the rest.
 */
export const SPEC_SCHEMA: Record<string, unknown> = {
  properties: {
    blocks: {
      items: {
        properties: {
          agg: { enum: AGGS },
          better: BETTER,
          field: STRING,
          items: { items: VALUE_REF_SCHEMA, type: 'array' },
          key: STRING,
          kind: { enum: ['spark', 'bars', 'meter', 'stat', 'grid', 'text'] },
          label: STRING,
          max: NUMBER,
          min: NUMBER,
          target: NUMBER,
          targetLabel: STRING,
          tones: { additionalProperties: { enum: TONES }, type: 'object' },
          total: { anyOf: [NUMBER, VALUE_REF_SCHEMA] },
          unit: STRING
        },
        required: ['kind'],
        type: 'object'
      },
      type: 'array'
    },
    headline: VALUE_REF_SCHEMA,
    rules: {
      items: {
        properties: { count: STRING, from: STRING, key: STRING, match: STRING, scale: NUMBER, text: STRING },
        required: ['from', 'match'],
        type: 'object'
      },
      type: 'array'
    },
    skip: STRING,
    stage: STRING,
    title: STRING
  },
  type: 'object'
}

// ── Patterns ───────────────────────────────────────────────────────────────────────────────

let linear: boolean | undefined

/**
 * Whether V8's linear-time engine (the `l` flag) is on: it runs a pattern in time linear in the
 * line, as omp's Rust matcher does, so no pattern a model writes can hang the chat. Node gates
 * it behind a V8 flag that can be set at runtime.
 */
function linearEngine(): boolean {
  if (linear === undefined) {
    try {
      setFlagsFromString('--enable-experimental-regexp-engine')
      linear = new RegExp('a', 'l').flags.includes('l')
    } catch {
      linear = false
    }
  }

  return linear
}

/** Backtracking traps when the linear engine is missing: lookaround, backreferences, nested quantifiers. */
const LOOKAROUND = /\(\?<?[=!]|\\[1-9]|\\k</

/** A quantified group that holds an unbounded quantifier (`(\d+,?)+`), outside classes and escapes. */
function nestedQuantifier(pattern: string): boolean {
  const groups: boolean[] = []
  let inClass = false

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]

    if (c === '\\') {
      i++
    } else if (inClass) {
      inClass = c !== ']'
    } else if (c === '[') {
      inClass = true
    } else if (c === '(') {
      groups.push(false)
    } else if (c === ')') {
      const inner = groups.pop() ?? false
      const next = pattern[i + 1]

      if (inner && (next === '+' || next === '*' || next === '{')) {
        return true
      }

      if (inner && groups.length) {
        groups[groups.length - 1] = true
      }
    } else if ((c === '+' || c === '*' || (c === '{' && /^\{\d*,\}/.test(pattern.slice(i)))) && groups.length) {
      groups[groups.length - 1] = true
    }
  }

  return false
}

/**
 * A rule's pattern as a RegExp: `(?P<name>` spelled as JavaScript spells it, compiled for the
 * linear-time engine; throws with a reason the author can act on.
 */
export function compilePattern(pattern: string): RegExp {
  const source = pattern.replace(/\(\?P</g, '(?<')

  if (linearEngine()) {
    try {
      return new RegExp(source, 'l')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      throw new Error(
        /linear time/.test(message) ? `\`${pattern}\` uses lookaround or backreferences, which are not allowed` : message
      )
    }
  }

  if (LOOKAROUND.test(source)) {
    throw new Error(`\`${pattern}\` uses lookaround or backreferences, which are not allowed`)
  }

  if (nestedQuantifier(source)) {
    throw new Error(`\`${pattern}\` repeats a group that repeats (like (\\d+,?)+); quantify one level only`)
  }

  return new RegExp(source)
}

/** One pattern's hit on a line: the captures of its named groups, in pattern order (undefined when a group took no part). */
export type Captures = (string | undefined)[]

/** Patterns run over lines: for each line in order, each pattern that matches it, in pattern order. */
export class LineMatcher {
  readonly #patterns: RegExp[]
  readonly #names: string[][]

  constructor(patterns: readonly string[]) {
    this.#patterns = patterns.map(compilePattern)
    this.#names = patterns.map(p => [...patternGroupNames(p)])
  }

  /** Each pattern's named groups, in pattern order. */
  groupNames(): string[][] {
    return this.#names.map(names => names.slice())
  }

  /** Every hit: the line's index, the pattern's index and its captures by group position. */
  matchLines(lines: readonly string[]): { line: number; pattern: number; captures: Captures }[] {
    const hits: { line: number; pattern: number; captures: Captures }[] = []

    lines.forEach((text, line) => {
      this.#patterns.forEach((re, pattern) => {
        const m = re.exec(text)

        if (m) {
          hits.push({ captures: this.#names[pattern]!.map(name => m.groups?.[name]), line, pattern })
        }
      })
    })

    return hits
  }
}

// ── Reading a spec ─────────────────────────────────────────────────────────────────────────

/** Lines the author saw for one source, for the validation dry run. */
export interface SampleLines {
  id: string
  lines: readonly string[]
}

export type Validation = { ok: true; spec: Spec } | { ok: false; errors: string[] }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** Why an answer declines to chart (its `skip`), or undefined for an answer offering a spec. */
export function specSkip(value: unknown): string | undefined {
  return isRecord(value) && typeof value.skip === 'string' && value.skip.trim() ? value.skip.trim() : undefined
}

/** Whether a rule's `from` names the source `id`. */
export function ruleReadsSource(from: string, id: string): boolean {
  if (from === '*') {
    return true
  }

  return from.endsWith('*') ? id.startsWith(from.slice(0, -1)) : from === id
}

/** Named groups a pattern declares, in pattern order. */
export function patternGroupNames(pattern: string): Set<string> {
  return new Set([...pattern.matchAll(NAMED_GROUP)].map(m => m[1]!))
}

/** The fields a rule feeds: one per named group but `key`, then its `count`. */
export function ruleFields(rule: Rule): RuleField[] {
  const fields: RuleField[] = []

  for (const group of patternGroupNames(rule.match)) {
    if (group !== rule.key) {
      fields.push({ count: false, field: group, text: group === rule.text })
    }
  }

  if (rule.count !== undefined) {
    fields.push({ count: true, field: rule.count, text: false })
  }

  return fields
}

/** Whether an aggregation needs numbers (everything but match counting). */
export function aggNeedsValue(agg: Agg): boolean {
  return agg !== 'count' && agg !== 'rate'
}

const NUMBER_PREFIX = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/
const SUFFIX_SCALE: Record<string, number> = { G: 1e9, K: 1e3, M: 1e6, k: 1e3 }

/** A captured number: `,`/`_` separators dropped, a `k`/`K`/`M`/`G` suffix multiplies; NaN without a leading number. */
export function parseValue(text: string): number {
  const first = text.charCodeAt(0)

  if (first >= 48 && first <= 57 && !/[xXbBoO]/.test(text.charAt(1))) {
    const plain = Number(text)

    if (Number.isFinite(plain)) {
      return plain
    }
  }

  const compact = text.trim().replace(/[,_]/g, '')
  const match = NUMBER_PREFIX.exec(compact)

  if (!match) {
    return Number.NaN
  }

  return Number.parseFloat(match[0]) * (SUFFIX_SCALE[compact.charAt(match[0].length)] ?? 1)
}

/**
 * Parses and checks an authored spec. `samples` (the lines the author saw) enable the dry run,
 * which rejects rules matching no sample line and number fields whose captures hold none. With
 * `brief` (the command) as well, a constant meter `total` or spark `target` must be a number
 * the command or the output states: an invented total draws a made-up fraction.
 */
export function validateSpec(value: unknown, samples?: readonly SampleLines[], brief?: string): Validation {
  const errors: string[] = []
  const spec = parseSpec(value, errors)

  if (!spec) {
    return { errors, ok: false }
  }

  const numeric = checkReferences(spec, errors)
  let matcher: LineMatcher | undefined

  try {
    matcher = new LineMatcher(spec.rules.map(r => r.match))
  } catch (error) {
    errors.push(`rules: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (matcher && samples && !errors.length) {
    dryRun(spec, matcher, samples, numeric, errors)

    if (brief !== undefined) {
      checkStatedNumbers(spec, samples, brief, errors)
    }
  }

  return errors.length ? { errors, ok: false } : { ok: true, spec }
}

/** A number as text writes it: digits with separators, a fraction, a `k`/`M`/`G` suffix. */
const WRITTEN_NUMBER = /\d[\d,_]*(?:\.\d+)?[kKMG]?/g

function checkStatedNumbers(spec: Spec, samples: readonly SampleLines[], brief: string, errors: string[]) {
  const stated = new Set<number>()
  const collect = (text: string) => {
    for (const m of text.matchAll(WRITTEN_NUMBER)) {
      stated.add(parseValue(m[0]))
    }
  }

  collect(brief)
  samples.forEach(s => s.lines.forEach(collect))
  spec.blocks.forEach((block, i) => {
    const where = `blocks[${i}] (${block.kind})`

    if (block.kind === 'meter' && typeof block.total === 'number' && !stated.has(block.total)) {
      errors.push(
        `${where}.total: ${block.total} appears nowhere in the command or its output; read the total from a line (a value ref) or show the value as a stat`
      )
    } else if (block.kind === 'spark' && block.target !== undefined && !stated.has(block.target)) {
      errors.push(`${where}.target: ${block.target} appears nowhere in the command or its output; set a target only when the job states one`)
    }
  })
}

function dryRun(spec: Spec, matcher: LineMatcher, samples: readonly SampleLines[], numeric: ReadonlyMap<string, string>, errors: string[]) {
  const groups = matcher.groupNames()
  let seen = false
  let matches = 0
  const numbers = new Set<string>()
  /** Field → its first capture that held no number. */
  const words = new Map<string, string>()

  for (const sample of samples) {
    if (!sample.lines.some(l => l.trim())) {
      continue
    }

    seen = true

    for (const hit of matcher.matchLines(sample.lines)) {
      const rule = spec.rules[hit.pattern]!

      if (!ruleReadsSource(rule.from, sample.id)) {
        continue
      }

      matches++
      groups[hit.pattern]!.forEach((field, at) => {
        const captured = hit.captures[at]

        if (field === rule.key || field === rule.text || captured === undefined) {
          return
        }

        if (Number.isFinite(parseValue(captured))) {
          numbers.add(field)
        } else if (!words.has(field)) {
          words.set(field, captured)
        }
      })
    }
  }

  if (seen && !matches) {
    errors.push('no rule matches any sample line; copy the exact text of lines that carry the numbers')
  }

  for (const [field, where] of numeric) {
    const word = words.get(field)

    if (word !== undefined && !numbers.has(field)) {
      errors.push(`${where}: field "${field}" needs numbers, but its group captured "${cut(word, 40)}" in the samples; capture only the digits`)
    }
  }
}

interface FieldFeed {
  value: boolean
  text: boolean
  keyGroups: Set<string>
}

function fieldFeeds(spec: Spec): Map<string, FieldFeed> {
  const fields = new Map<string, FieldFeed>()

  for (const rule of spec.rules) {
    for (const { count, field, text } of ruleFields(rule)) {
      const feed = fields.get(field) ?? { keyGroups: new Set<string>(), text: false, value: false }
      feed.value ||= !text && !count
      feed.text ||= text

      if (rule.key !== undefined) {
        feed.keyGroups.add(rule.key)
      }

      fields.set(field, feed)
    }
  }

  return fields
}

/** Checks rules and references; returns the fields read as numbers, each with the first place reading it. */
function checkReferences(spec: Spec, errors: string[]): Map<string, string> {
  const feeds = fieldFeeds(spec)
  const numeric = new Map<string, string>()

  const checkField = (where: string, field: string, agg: Agg | undefined, key?: string) => {
    const feed = feeds.get(field)

    if (!feed) {
      return errors.push(`${where}: unknown field "${field}"; no rule has a group (?P<${field}>…) or count "${field}"`)
    }

    if (key !== undefined && feed.keyGroups.has(key)) {
      errors.push(`${where}.key: "${key}" is the name of the key group; set one of its values (one model, one job) or omit \`key\``)
    }

    if (agg === undefined || !aggNeedsValue(agg)) {
      return
    }

    if (!feed.value) {
      errors.push(`${where}: agg "${agg}" needs numbers, but field "${field}" only counts matches or keeps text`)
    } else if (!numeric.has(field)) {
      numeric.set(field, where)
    }
  }

  const checkRef = (where: string, ref: ValueRef) => checkField(where, ref.field, ref.agg, ref.key)

  spec.rules.forEach((rule, i) => {
    const where = `rules[${i}]`

    if (rule.text !== undefined && rule.text === rule.key) {
      errors.push(`${where}.text: the key group is not a field`)
    }

    for (const group of patternGroupNames(rule.match)) {
      if (group !== rule.key && !FIELD_NAME.test(group)) {
        errors.push(`${where}.match: group "${group}" names a field, so it must match ${FIELD_NAME.source}`)
      }
    }

    if (!ruleFields(rule).length) {
      errors.push(`${where}: feeds no field; name a group (?P<field>…) besides the key, or set \`count\``)
    }
  })

  if (spec.headline) {
    checkRef('headline', spec.headline)
  }

  if (spec.stage) {
    checkField('stage', spec.stage, undefined)
  }

  spec.blocks.forEach((block, i) => {
    const where = `blocks[${i}] (${block.kind})`

    switch (block.kind) {
      case 'spark':
        return checkField(where, block.field, 'last', block.key)

      case 'bars':
        checkField(where, block.field, block.agg)

        return feeds.get(block.field)?.keyGroups.size === 0 ? errors.push(`${where}: bars need a rule with \`key\``) : undefined

      case 'meter':
        checkField(where, block.field, block.agg, block.key)

        return typeof block.total === 'number' ? undefined : checkRef(`${where}.total`, block.total)

      case 'stat':
        return block.items.forEach((item, j) => checkRef(`${where}.items[${j}]`, item))

      case 'grid':
        checkField(where, block.field, undefined)

        return feeds.get(block.field)?.keyGroups.size === 0 ? errors.push(`${where}: grid needs a rule with \`key\``) : undefined

      case 'text':
        return checkField(where, block.field, undefined)
    }
  })

  return numeric
}

// ── Structural parsing ─────────────────────────────────────────────────────────────────────

function parseSpec(value: unknown, errors: string[]): Spec | undefined {
  if (!isRecord(value)) {
    errors.push('spec: expected an object')

    return undefined
  }

  const title = str(value.title, 'title', errors, { cut: MAX_TITLE_CHARS, required: true })
  const rules = list(value.rules, 'rules', errors, 1, MAX_RULES)?.map((r, i) => parseRule(r, `rules[${i}]`, errors))
  const blocks = list(value.blocks, 'blocks', errors, 1, MAX_BLOCKS)?.map((b, i) => parseBlock(b, `blocks[${i}]`, errors))
  let headline: Spec['headline']

  if (value.headline !== undefined) {
    const ref = parseValueRef(value.headline, 'headline', errors)
    const label = isRecord(value.headline) ? str(value.headline.label, 'headline.label', errors, { cut: MAX_LABEL_CHARS }) : undefined

    if (ref) {
      headline = label ? { ...ref, label } : ref
    }
  }

  const stage = value.stage === undefined ? undefined : fieldName(value.stage, 'stage', errors)

  if (errors.length || title === undefined || !rules || !blocks || rules.some(r => !r) || blocks.some(b => !b)) {
    return undefined
  }

  return {
    blocks: blocks as BlockSpec[],
    rules: rules as Rule[],
    title,
    ...(headline ? { headline } : {}),
    ...(stage ? { stage } : {})
  }
}

function parseRule(value: unknown, where: string, errors: string[]): Rule | undefined {
  if (!isRecord(value)) {
    errors.push(`${where}: expected an object`)

    return undefined
  }

  const from = str(value.from, `${where}.from`, errors, { required: true })

  if (from !== undefined && !SOURCE_ID.test(from)) {
    errors.push(`${where}.from: invalid source id "${from}"`)
  }

  const match = str(value.match, `${where}.match`, errors, { max: MAX_PATTERN_CHARS, required: true })

  const group = (name: 'key' | 'text') => {
    const raw = str(value[name], `${where}.${name}`, errors)

    if (raw !== undefined && !GROUP_NAME.test(raw)) {
      errors.push(`${where}.${name}: invalid group name "${raw}"`)
    }

    return raw
  }

  const key = group('key')
  const text = group('text')
  const count = value.count === undefined ? undefined : fieldName(value.count, `${where}.count`, errors)
  const scale = num(value.scale, `${where}.scale`, errors)

  if (from === undefined || match === undefined) {
    return undefined
  }

  // `key` and `text` name groups of the pattern, and authors often name ones it lacks. A `text`
  // on a pattern with no groups means the matched text itself: the pattern is wrapped in that
  // group. Otherwise the role is dropped, and a block reading the missing field still fails.
  const groups = patternGroupNames(match)
  const wrap = text !== undefined && FIELD_NAME.test(text) && groups.size === 0
  const keyGroup = key !== undefined && groups.has(key) ? key : undefined
  const textGroup = text !== undefined && (wrap || groups.has(text)) ? text : undefined

  return {
    from,
    match: wrap ? `(?P<${text}>${match})` : match,
    ...(keyGroup !== undefined ? { key: keyGroup } : {}),
    ...(textGroup !== undefined ? { text: textGroup } : {}),
    ...(count !== undefined ? { count } : {}),
    ...(scale !== undefined ? { scale } : {})
  }
}

function parseValueRef(value: unknown, where: string, errors: string[]): ValueRef | undefined {
  if (!isRecord(value)) {
    errors.push(`${where}: expected an object`)

    return undefined
  }

  const field = fieldName(value.field, `${where}.field`, errors)
  const key = str(value.key, `${where}.key`, errors, { max: 120 })
  const agg = aggregation(value.agg, `${where}.agg`, errors)
  const unit = str(value.unit, `${where}.unit`, errors, { cut: MAX_UNIT_CHARS })
  const digits = num(value.digits, `${where}.digits`, errors)

  if (digits !== undefined && (!Number.isInteger(digits) || digits < 0 || digits > 4)) {
    errors.push(`${where}.digits: expected an integer 0–4`)
  }

  const better = betterValue(value.better, `${where}.better`, errors)

  if (field === undefined || agg === undefined) {
    return undefined
  }

  return {
    agg,
    field,
    ...(key !== undefined ? { key } : {}),
    ...(unit !== undefined ? { unit } : {}),
    ...(digits !== undefined ? { digits } : {}),
    ...(better !== undefined ? { better } : {})
  }
}

function parseBlock(value: unknown, where: string, errors: string[]): BlockSpec | undefined {
  if (!isRecord(value)) {
    errors.push(`${where}: expected an object`)

    return undefined
  }

  const before = errors.length
  const label = () => str(value.label, `${where}.label`, errors, { cut: MAX_LABEL_CHARS, required: true }) ?? ''
  const unit = () => str(value.unit, `${where}.unit`, errors, { cut: MAX_UNIT_CHARS })
  const field = () => fieldName(value.field, `${where}.field`, errors) ?? ''
  const optional = <T>(entry: T | undefined, name: string): Record<string, T> => (entry === undefined ? {} : { [name]: entry })
  let block: BlockSpec | undefined

  switch (value.kind) {
    case 'spark':
      block = {
        field: field(),
        kind: 'spark',
        label: label(),
        ...optional(str(value.key, `${where}.key`, errors, { max: 120 }), 'key'),
        ...optional(unit(), 'unit'),
        ...optional(betterValue(value.better, `${where}.better`, errors), 'better'),
        ...optional(num(value.target, `${where}.target`, errors), 'target'),
        ...optional(str(value.targetLabel, `${where}.targetLabel`, errors, { cut: MAX_LABEL_CHARS }), 'targetLabel'),
        ...optional(num(value.min, `${where}.min`, errors), 'min'),
        ...optional(num(value.max, `${where}.max`, errors), 'max')
      }

      break

    case 'bars':
      block = {
        agg: aggregation(value.agg, `${where}.agg`, errors) ?? 'last',
        field: field(),
        kind: 'bars',
        label: label(),
        ...optional(unit(), 'unit'),
        ...optional(num(value.max, `${where}.max`, errors), 'max'),
        ...optional(betterValue(value.better, `${where}.better`, errors), 'better')
      }

      break

    case 'meter': {
      const whole = typeof value.total === 'string' ? Number(value.total) : value.total

      // A meter whose whole is unknown (absent, `"?"`, null) is a plain number: drawn as a stat.
      if (!isRecord(whole) && (typeof whole !== 'number' || Number.isNaN(whole))) {
        const ref = parseValueRef(value, where, errors)
        block = ref && { items: [{ ...ref, label: label() }], kind: 'stat' }

        break
      }

      let total: number | ValueRef | undefined

      if (typeof whole === 'number') {
        if (!Number.isFinite(whole) || whole <= 0) {
          errors.push(`${where}.total: expected a positive number`)
        } else {
          total = whole
        }
      } else {
        total = parseValueRef(value.total, `${where}.total`, errors)
      }

      block = {
        agg: aggregation(value.agg, `${where}.agg`, errors) ?? 'last',
        field: field(),
        kind: 'meter',
        label: label(),
        total: total ?? 1,
        ...optional(str(value.key, `${where}.key`, errors, { max: 120 }), 'key'),
        ...optional(unit(), 'unit')
      }

      break
    }

    case 'stat': {
      const items =
        list(value.items, `${where}.items`, errors, 1, MAX_STAT_ITEMS)?.map((item, i) => {
          const at = `${where}.items[${i}]`
          const ref = parseValueRef(item, at, errors)
          const itemLabel = isRecord(item) ? str(item.label, `${at}.label`, errors, { cut: MAX_LABEL_CHARS, required: true }) : undefined

          return ref && itemLabel !== undefined ? { ...ref, label: itemLabel } : undefined
        }) ?? []

      block = { items: items.filter(i => i !== undefined), kind: 'stat' }

      break
    }

    case 'grid': {
      const tones: Record<string, Tone> = {}

      if (!isRecord(value.tones)) {
        errors.push(`${where}.tones: expected an object of status substring → tone`)
      } else {
        let n = 0

        for (const [status, tone] of Object.entries(value.tones)) {
          if (++n > MAX_GRID_TONES) {
            errors.push(`${where}.tones: at most ${MAX_GRID_TONES} entries`)

            break
          }

          if (typeof tone === 'string' && TONES.includes(tone)) {
            tones[status] = tone
          } else {
            errors.push(`${where}.tones.${status}: expected one of ${TONES.join(', ')}`)
          }
        }
      }

      block = { field: field(), kind: 'grid', label: label(), tones }

      break
    }

    case 'text':
      block = { field: field(), kind: 'text' }

      break

    default:
      errors.push(`${where}.kind: expected spark, bars, meter, stat, grid or text`)

      return undefined
  }

  return errors.length === before ? block : undefined
}

function list(value: unknown, where: string, errors: string[], min: number, max: number): unknown[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${where}: expected an array`)

    return undefined
  }

  if (value.length < min || value.length > max) {
    errors.push(`${where}: expected ${min}–${max} entries, got ${value.length}`)

    return undefined
  }

  return value
}

function str(value: unknown, where: string, errors: string[], o: { max?: number; cut?: number; required?: boolean } = {}): string | undefined {
  if (value === undefined || value === null) {
    if (o.required) {
      errors.push(`${where}: required`)
    }

    return undefined
  }

  if (typeof value !== 'string') {
    errors.push(`${where}: expected a string`)

    return undefined
  }

  const trimmed = value.trim()

  if (!trimmed) {
    if (o.required) {
      errors.push(`${where}: must not be empty`)
    }

    return undefined
  }

  if (o.max !== undefined && trimmed.length > o.max) {
    errors.push(`${where}: at most ${o.max} characters`)

    return undefined
  }

  // Display text (titles, labels, units) is cut to fit rather than sent back for a retry, and
  // models sometimes write it HTML-escaped (`ACL &amp; update`).
  return o.cut === undefined ? trimmed : cut(unescape(trimmed), o.cut)
}

const ENTITIES: Record<string, string> = { '&#39;': "'", '&amp;': '&', '&gt;': '>', '&lt;': '<', '&quot;': '"' }

function unescape(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, e => ENTITIES[e] ?? e)
}

function num(value: unknown, where: string, errors: string[]): number | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${where}: expected a finite number`)

    return undefined
  }

  return value
}

function fieldName(value: unknown, where: string, errors: string[]): string | undefined {
  const name = str(value, where, errors, { required: true })

  if (name !== undefined && !FIELD_NAME.test(name)) {
    errors.push(`${where}: "${name}" must match ${FIELD_NAME.source}`)

    return undefined
  }

  return name
}

function aggregation(value: unknown, where: string, errors: string[]): Agg | undefined {
  if (typeof value === 'string' && (AGGS as readonly string[]).includes(value)) {
    return value as Agg
  }

  errors.push(`${where}: expected one of ${AGGS.join(', ')}`)

  return undefined
}

function betterValue(value: unknown, where: string, errors: string[]): Better | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  if (value === 'higher' || value === 'lower') {
    return value
  }

  errors.push(`${where}: expected "higher" or "lower"`)

  return undefined
}
