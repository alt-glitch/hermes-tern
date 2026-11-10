// Frozen-install regression: the real packaged suite must work without nested npm ci.
// Expected versions and integrity values come from the unchanged donor lock.
import { readFile } from 'node:fs/promises'
import { createRequire, findPackageJSON } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as z from 'zod/mini'
import { describe, expect, it } from 'vitest'

import { decodeJson } from '../wire/json.js'

const dependencies = z.record(z.string(), z.string())
const frontendManifest = z.object({
  workspaces: z.object({
    packages: z.array(z.string()),
    selfContained: z.array(z.string())
  }),
  trustedDependencies: z.optional(z.array(z.string()))
})
const generationManifest = z.object({
  name: z.string(),
  version: z.string(),
  dependencies
})
const bunLock = z.object({
  workspaces: z.record(z.string(), z.object({
    name: z.string(),
    version: z.optional(z.string()),
    dependencies: z.optional(dependencies)
  })),
  packages: z.record(z.string(), z.array(z.unknown()))
})
const npmLock = z.object({ packages: z.record(z.string(), z.unknown()) })
const npmPackage = z.object({ version: z.string(), integrity: z.string() })
const bunPackage = z.tuple([z.string(), z.string(), z.unknown(), z.string()])
const parserMetadata = z.object({
  optionalPeers: z.array(z.string()),
  peerDependencies: dependencies,
  dependencies
})
const installedParser = z.object({
  name: z.literal('@openuidev/lang-core'),
  version: z.string(),
  scripts: dependencies,
  dependencies,
  peerDependencies: dependencies,
  peerDependenciesMeta: z.record(z.string(), z.object({ optional: z.boolean() }))
})

const root = new URL('../../', import.meta.url)
const generator = new URL('openui/openui-generation/', root)
const parserRequire = createRequire(fileURLToPath(new URL('package.json', generator)))

async function loadJson(url: URL): Promise<unknown> {
  return decodeJson(await readFile(url, 'utf8'))
}

describe('OpenUI dependencies in the standard frozen Bun install', () => {
  it('registers the donor parser as a self-contained workspace, not a test-time npm install', async () => {
    const frontend = frontendManifest.parse(await loadJson(new URL('package.json', root)))
    const generation = generationManifest.parse(await loadJson(new URL('package.json', generator)))
    const lockText = await readFile(new URL('bun.lock', root), 'utf8')
    // Bun emits JSON with trailing commas; normalize only that syntax before decoding.
    const lock = bunLock.parse(decodeJson(lockText.replace(/,\s*([}\]])/g, '$1')))
    const donor = npmLock.parse(await loadJson(new URL('package-lock.json', generator)))

    expect(frontend.workspaces.packages).toContain('openui/openui-generation')
    expect(frontend.workspaces.selfContained).toContain('openui/openui-generation')
    expect(generation.dependencies).toEqual({ '@openuidev/lang-core': '0.3.1', zod: '4.0.0' })
    expect(lock.workspaces['openui/openui-generation']).toMatchObject({
      name: generation.name, version: generation.version, dependencies: generation.dependencies
    })
    const workspace = z.tuple([z.string()]).parse(lock.packages[generation.name])
    expect(workspace[0]).toBe('hermes-openui-generation-experiment@workspace:openui/openui-generation')

    for (const [key, installed] of [
      ['@openuidev/lang-core', '@openuidev/lang-core'],
      ['ci-info', 'ci-info'],
      ['hermes-openui-generation-experiment/zod', 'zod']
    ] as const) {
      const original = npmPackage.parse(donor.packages[`node_modules/${installed}`])
      const resolved = bunPackage.parse(lock.packages[key])
      expect(original.integrity).toMatch(/^sha512-/)
      expect(resolved[0]).toBe(`${installed}@${original.version}`)
      expect(resolved[3]).toBe(original.integrity)
    }
    const parser = bunPackage.parse(lock.packages['@openuidev/lang-core'])
    const metadata = parserMetadata.parse(parser[2])
    expect(metadata).toEqual({
      optionalPeers: ['@modelcontextprotocol/sdk'],
      peerDependencies: { '@modelcontextprotocol/sdk': '>=1.0.0', zod: '^3.25.0 || ^4.0.0' },
      dependencies: { 'ci-info': '^4.4.0' }
    })
    // Bun 1.4 omits hasInstallScript; the installed package still declares its lifecycle scripts.
    const manifest = findPackageJSON('@openuidev/lang-core', new URL('package.json', generator))
    if (!manifest) throw new Error('Missing installed OpenUI parser manifest')
    const installed = installedParser.parse(await loadJson(pathToFileURL(manifest)))
    const original = z.object({ version: z.string(), hasInstallScript: z.literal(true) }).parse(donor.packages['node_modules/@openuidev/lang-core'])
    expect(installed.version).toBe(original.version)
    expect(parser[0]).toBe(`${installed.name}@${installed.version}`)
    expect(['preinstall', 'install', 'postinstall'].some(name => Boolean(installed.scripts[name]?.trim()))).toBe(true)
    expect(installed.dependencies).toEqual(metadata.dependencies)
    expect(installed.peerDependencies).toEqual(metadata.peerDependencies)
    expect(installed.peerDependenciesMeta).toEqual({ '@modelcontextprotocol/sdk': { optional: true } })
    expect(await readFile(new URL('.npmrc', generator), 'utf8')).toMatch(/^ignore-scripts=true$/m)
    expect(frontend.trustedDependencies ?? []).not.toContain('@openuidev/lang-core')
    expect(bunPackage.parse(lock.packages['zod'])[0]).toBe('zod@4.4.3')
  })

  it('resolves the exact generation-local Zod instead of the frontend Zod', async () => {
    const manifest = z.object({ version: z.string() }).parse(
      await loadJson(pathToFileURL(parserRequire.resolve('zod/package.json')))
    )
    expect(manifest.version).toBe('4.0.0')
  })
})
