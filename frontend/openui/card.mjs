// Host-only data contract for pinned ephemeral-ui card.v0. No card code is evaluated.
import { createHash } from 'node:crypto'
import { constants, readFileSync } from 'node:fs'
import { mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_BLOB = 'ccafc9d00f95f21c389f8ce8a9aa14491475033f'
export const CARD_MAX_BYTES = 64 * 1024
const TEXT_KEYS = ['title', 'text', 'summary', 'description', 'subject', 'status', 'label', 'query', 'body', 'message', 'note']
const bytes = readFileSync(new URL('./schema/card.v0.json', import.meta.url))
const blob = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex')

if (blob !== SOURCE_BLOB) {
  throw new Error('Pinned ephemeral-ui card.v0 schema has changed.')
}

const schema = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
const properties = schema.properties

if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema' ||
    schema.type !== 'object' || !Array.isArray(schema.required) ||
    schema.required.join(',') !== 'kind,app' || !properties ||
    !Array.isArray(properties.kind?.enum) || !properties.kind.enum.length) {
  throw new Error('Pinned card schema is unsupported.')
}

const allowed = new Set([...Object.keys(properties), ...TEXT_KEYS, 'fields', 'buttons'])
const controls = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u

function fail(reason) {
  throw new Error('Invalid card.v0: ' + reason)
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function string(value, max, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || controls.test(value)) {
    fail(name + ' must be bounded, nonempty text without controls.')
  }
}

function bounded(value) {
  const seen = new Set()
  let count = 0

  function visit(item, depth) {
    if (++count > 1024 || depth > 8) fail('nested data limit exceeded.')
    if (typeof item === 'string') {
      if (item.length > 4096 || controls.test(item)) fail('control character or oversized text.')
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail('non-finite number.')
    } else if (Array.isArray(item)) {
      if (item.length > 64 || seen.has(item)) fail('array bound or cycle.')
      seen.add(item)
      item.forEach(v => visit(v, depth + 1))
    } else if (object(item)) {
      if (seen.has(item)) fail('cyclic object.')
      seen.add(item)
      const keys = Object.keys(item)
      if (keys.length > 64) fail('too many object keys.')
      for (const key of keys) {
        if (!key || key.length > 64 || controls.test(key)) fail('invalid property name.')
        visit(item[key], depth + 1)
      }
    } else if (item !== null && typeof item !== 'boolean') {
      fail('only JSON data is allowed.')
    }
  }

  visit(value, 0)
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json, 'utf8') > CARD_MAX_BYTES) fail('document exceeds 64 KiB.')
  return json
}

function enumValue(value, choices, name) {
  if (!choices.includes(value)) fail('invalid ' + name + '.')
}

function optionalText(obj, key, max = 256) {
  if (obj[key] !== undefined) string(obj[key], max, key)
}

export function validateCardDocument(input) {
  if (!object(input)) fail('expected an object.')
  bounded(input)

  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) fail('unknown top-level key ' + key + '.')
  }
  for (const key of schema.required) {
    if (!Object.hasOwn(input, key)) fail('missing ' + key + '.')
  }
  enumValue(input.kind, properties.kind.enum, 'kind')
  string(input.app, 80, 'app')
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(input.app)) fail('invalid app id.')

  if (input.ttl !== undefined && input.ttl !== 'until-done' && input.ttl !== 'pinned' &&
      !(Number.isSafeInteger(input.ttl) && input.ttl >= 0 && input.ttl <= 31_536_000_000)) {
    fail('invalid ttl.')
  }
  if (input.actions !== undefined) enumValue(input.actions, properties.actions.enum, 'actions')
  if (input.kind.startsWith('trace') && input.actions === 'host-confirmed') {
    fail('trace cards never request writes.')
  }

  if (input.render !== undefined) {
    if (!object(input.render)) fail('render must be an object.')
    for (const key of Object.keys(input.render)) {
      if (!Object.hasOwn(properties.render.properties, key)) fail('unknown render key.')
    }
    optionalText(input.render, 'host', 80)
    optionalText(input.render, 'theme', 80)
    if (input.render.brand !== undefined) enumValue(input.render.brand, properties.render.properties.brand.enum, 'brand')
  }
  if (input.input !== undefined && !(object(input.input) || Array.isArray(input.input) ||
      (typeof input.input === 'string' && /^\/api\//.test(input.input)))) {
    fail('input must be JSON data or an /api/ path.')
  }
  if (input.layers !== undefined) {
    if (!Array.isArray(input.layers) || input.layers.length > 6 || new Set(input.layers).size !== input.layers.length) {
      fail('invalid layers.')
    }
    for (const layer of input.layers) enumValue(layer, schema.$defs.layer.enum, 'layer')
  }
  if (input.options !== undefined) {
    if (!object(input.options)) fail('options must be an object.')
    for (const [key, value] of Object.entries(input.options)) {
      const spec = properties.options.properties[key]
      if (!spec) fail('unknown option ' + key + '.')
      if (spec.enum) enumValue(value, spec.enum, key)
      else string(value, 128, key)
    }
  }

  for (const key of TEXT_KEYS) optionalText(input, key, key === 'body' ? 3000 : 512)
  if (input.fields !== undefined) {
    if (!object(input.fields) || Object.keys(input.fields).length > 16) fail('fields must be at most 16 text items.')
    for (const [key, value] of Object.entries(input.fields)) {
      if (!/^[a-z][a-z0-9 _.-]{0,39}$/i.test(key)) fail('invalid field label.')
      string(value, 512, 'field ' + key)
    }
  }
  if (input.buttons !== undefined) {
    if (!Array.isArray(input.buttons) || input.buttons.length > 8) fail('too many buttons.')
    for (const button of input.buttons) {
      if (typeof button === 'string') {
        string(button, 80, 'button')
      } else if (object(button) && Object.keys(button).every(k => k === 'label' || k === 'action')) {
        string(button.label, 80, 'button label')
        if (button.action !== undefined) string(button.action, 128, 'ignored button action')
      } else {
        fail('button must provide only a label and optional inert action id.')
      }
    }
  }

  return input
}

export function validateScope(scope) {
  let parts
  try {
    parts = JSON.parse(scope)
  } catch {
    fail('invalid scope JSON.')
  }
  if (!Array.isArray(parts) || parts.length !== 2 || typeof parts[0] !== 'string' ||
      !parts[0] || typeof parts[1] !== 'string' || JSON.stringify(parts) !== scope ||
      scope.length > 256 || controls.test(scope) || controls.test(parts[0]) || controls.test(parts[1])) {
    fail('scope must be the exact session/branch JSON pair.')
  }
}

export function cardId(card, scope) {
  validateScope(scope)
  validateCardDocument(card)
  return createHash('sha256').update('ephemeral-ui/card.v0\0').update(scope)
    .update('\0').update(JSON.stringify(card)).digest('hex')
}

export function validatePreparedCard(input, scope) {
  if (!object(input) || Object.keys(input).sort().join(',') !== 'card,id,kind,scope,version' ||
      input.kind !== 'hermes.visual.card' || input.version !== 0 || input.scope !== scope ||
      typeof input.id !== 'string' || !/^[a-f0-9]{64}$/.test(input.id)) {
    fail('invalid prepared card envelope or session scope.')
  }
  validateCardDocument(input.card)
  if (cardId(input.card, scope) !== input.id) fail('prepared card identity mismatch.')
  return input
}

async function boundedInput(path) {
  if (!path.endsWith('.json') || controls.test(path)) fail('expected a JSON file.')
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > CARD_MAX_BYTES) fail('input is not a bounded regular file.')
    const data = Buffer.alloc(CARD_MAX_BYTES + 1)
    let used = 0
    for (;;) {
      const { bytesRead } = await file.read(data, used, data.length - used, null)
      used += bytesRead
      if (used > CARD_MAX_BYTES) fail('input exceeds 64 KiB.')
      if (!bytesRead) break
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, used)))
  } finally {
    await file.close()
  }
}

export async function prepareCardFile(inputPath, scope, outputDir) {
  validateScope(scope)
  if (!isAbsolute(outputDir) || controls.test(outputDir)) fail('output directory must be absolute.')
  const frontend = resolve(fileURLToPath(new URL('../', import.meta.url)))
  const output = resolve(outputDir)
  if (output === frontend || output.startsWith(frontend + sep)) fail('output must be outside the plugin.')
  const card = validateCardDocument(await boundedInput(inputPath))
  const id = cardId(card, scope)
  const bundle = { kind: 'hermes.visual.card', version: 0, id, scope, card }
  await mkdir(output, { recursive: true })
  const directory = await realpath(output)
  if (directory === frontend || directory.startsWith(frontend + sep)) fail('output resolves inside the plugin.')
  const path = join(directory, id + '.hvisual.json')
  const serialized = JSON.stringify(bundle) + '\n'
  try {
    await writeFile(path, serialized, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error?.code !== 'EEXIST' || (await readFile(path, 'utf8')) !== serialized) throw error
  }
  return { kind: 'hermes.visual.candidate', version: 1, id, path, scope }
}
