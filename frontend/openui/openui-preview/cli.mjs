#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createBundle, prepareArtifact, validateBundle, fingerprints, assertCurrent, assertOutputDirectory, MAX_BYTES } from './src/bundle.mjs';
import { createControl, capturePreview } from './src/control.mjs';
import { INTENT_MAX_BYTES, prepareIntentArtifact } from './src/intent-document.mjs';
import { digest } from '../openui-generation/src/catalog.mjs';

async function boundedRead(path, cap = MAX_BYTES) {
  const info = await stat(path);
  if (!info.isFile() || info.size > cap) throw new Error('Expected a bounded regular input file.');
  const bytes = await readFile(path);
  if (bytes.length > cap) throw new Error('Input grew beyond its byte cap.');
  return bytes.toString('utf8');
}

const [command, ...args] = process.argv.slice(2);
// Opt-in machine output for transcript discovery; the default path-only CLI stays unchanged.
const jsonOutput = (command === 'prepare' || command === 'prepare-intent') && args.at(-1) === '--json';
if (jsonOutput) args.pop();
try {
  if ((command === 'prepare' || command === 'prepare-intent') && args.length === 4) {
    const intent = command === 'prepare-intent';
    const [sourcePath, dataPath, scope, destination] = args;
    const out = await assertOutputDirectory(destination);
    const build = await fingerprints();
    const raw = await boundedRead(dataPath, intent ? INTENT_MAX_BYTES : MAX_BYTES);
    const artifact = intent ? prepareIntentArtifact(raw, build.rendererHash) : prepareArtifact(raw, build.rendererHash);
    const { createGenerationAdapter } = await import('../openui-generation/src/adapter.mjs');
    const adapter = await createGenerationAdapter({ library: intent ? 'intent' : 'repository' });
    // The host registers the snapshot key; the program may only name it.
    const selection = adapter.compile(await boundedRead(sourcePath, 32768), {
      scope, snapshots: new Map([[intent ? 'z0' : 'demo', artifact]]),
    });
    const bundle = createBundle(selection, artifact, { width: 1280, height: 900, appearance: 'dark' }, build.bridgeHash);
    await mkdir(out, { recursive: true, mode: 0o700 });
    const path = join(out, `${bundle.id}.hvisual.json`);
    const json = JSON.stringify(bundle) + '\n';
    if (Buffer.byteLength(json) > MAX_BYTES) throw new Error('Serialized preview exceeds 8 MiB.');
    try { await writeFile(path, json, { flag: 'wx', mode: 0o400 }); }
    catch (error) { if (error.code !== 'EEXIST' || await boundedRead(path) !== json) throw error; }
    console.log(jsonOutput ? JSON.stringify({ kind: 'hermes.visual.candidate', version: 1, id: bundle.id, path, scope }) : path);
  } else if (command === 'capture' && args.length === 4 && args[3] === '--allow-control-input') {
    const [bundlePath, endpoint, output] = args;
    const out = await assertOutputDirectory(output);
    const raw = await boundedRead(bundlePath), bundle = validateBundle(JSON.parse(raw));
    const before = await fingerprints(); assertCurrent(bundle, bundle.selection.scope, before);
    await mkdir(out, { recursive: true, mode: 0o700 });
    const evidencePath = join(out, `capture-${randomUUID()}.json`);
    try {
      const result = await capturePreview(bundle, { control: createControl(endpoint), shotRoot: out });
      const after = await fingerprints(); assertCurrent(bundle, bundle.selection.scope, after);
      if (digest(await boundedRead(bundlePath)) !== digest(raw)) throw new Error('Preview file changed during capture.');
      await writeFile(evidencePath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      console.log(`Captured, NOT visually inspected or published: ${evidencePath}`);
    } catch (error) {
      await writeFile(evidencePath, JSON.stringify({ ...error.captureEvidence, status: 'capture-failed', error: error.message }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      throw error;
    }
  } else {
    throw new Error('Usage: node cli.mjs prepare <program.openui> <host-document.json> <session:branch> <output-dir> [--json]\n  or: node cli.mjs prepare-intent <program.openui> <intent-board.json> <session:branch> <output-dir> [--json]  (snapshot key "z0")\n  or: node cli.mjs capture <bundle.hvisual.json> <control-socket> <tern-shot-output-dir> --allow-control-input');
  }
} catch (error) {
  console.error(`${error.code ?? 'error'}: ${error.message}`);
  process.exitCode = 1;
}
