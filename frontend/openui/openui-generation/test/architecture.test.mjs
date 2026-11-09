import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  ARCHITECTURE_CATALOG, ARCHITECTURE_LIBRARY, ARCHITECTURE_SERVICES,
  bindArchitecture, projectArchitecture,
} from '../src/architecture.mjs';
import { createGenerationAdapter } from '../src/adapter.mjs';

process.env.OPENUI_TELEMETRY_DISABLED = '1';
const fixture = name => readFileSync(new URL('../fixtures/' + name, import.meta.url), 'utf8');
const element = (typeName, props) => ({ type: 'element', typeName, props, partial: false, hasDynamicProps: false });
const snapshot = { id: 'a'.repeat(64), rendererHash: 'b'.repeat(64) };
const context = () => ({ scope: 'session:branch', snapshots: new Map([['arch', snapshot]]) });
const bad = (fn, code) => assert.throws(fn, error => error.code === code);

test('architecture fixture matches the exact public gh-pages schema blob at 63e06b29', () => {
  const raw = fixture('architecture.v0.json');
  const sha = createHash('sha1').update('blob ' + Buffer.byteLength(raw) + '\0').update(raw).digest('hex');
  assert.equal(sha, 'ce65a7b43ed6e03247ccda391952771e33c021ee');
  const schema = JSON.parse(raw);
  assert.deepEqual(schema.required, ['v', 'title', 'nodes', 'edges']);
  assert.equal(schema.properties.v.const, 0);
  assert.equal(schema.properties.provenance.const, 'authored-example');
  assert.equal(schema.properties.nodes.minItems, 1);
  assert.equal(schema.properties.nodes.maxItems, 24);
  assert.equal(schema.properties.edges.maxItems, 64);
  assert.equal(schema.properties.edges.items.properties.label.maxLength, 100);
  assert.equal(schema.properties.nodes.items.properties.id.pattern, '^[a-zA-Z][a-zA-Z0-9_-]{0,39}$');
});
test('pinned SERVICES fixture is the complete vetted 39-key set', () => {
  const services = JSON.parse(fixture('architecture-services.v0.json'));
  assert.deepEqual(ARCHITECTURE_SERVICES, services);
  assert.equal(services.length, 39);
  assert.equal(new Set(services).size, services.length);
  for (const id of ['client', 'aws-lambda', 'lambda', 'k3s', 'z0int', 'llamacpp', 'comfyui']) assert.ok(services.includes(id));
  assert.equal(ARCHITECTURE_LIBRARY.id, 'ephemeral-architecture/v0');
  assert.deepEqual(Object.keys(ARCHITECTURE_CATALOG), ['ArchitectureBoard']);
});
test('only a host snapshot key may be selected; no model data, actions or handlers', () => {
  assert.deepEqual(projectArchitecture(element('ArchitectureBoard', { snapshotId: 'arch' })), { snapshotId: 'arch' });
  for (const props of [{ snapshotId: '../secret' }, { snapshotId: '' }, { snapshotId: 'arch', nodes: [] },
    { snapshotId: 'arch', onApprove: 'run' }, { snapshotId: 4 }]) bad(() => projectArchitecture(element('ArchitectureBoard', props)), props.snapshotId === 'arch' ? 'props' : 'snapshot');
  bad(() => projectArchitecture(element('ApproveArchitecture', { snapshotId: 'arch' })), 'element');
  const selection = bindArchitecture({ snapshotId: 'arch' }, 'source', context());
  assert.deepEqual(selection.view, { kind: 'architecture-board' });
  assert.equal(selection.generator.adapter, 'bounded-architecture-selection/v0');
  bad(() => bindArchitecture({ snapshotId: 'missing' }, 'source', context()), 'snapshot');
});
test('real parser compiles an inert authored board and rejects a foreign component', async () => {
  const adapter = await createGenerationAdapter({ library: 'architecture' });
  const selection = adapter.compile(fixture('architecture.openui'), context());
  assert.equal(selection.view.kind, 'architecture-board');
  assert.match(adapter.prompt, /ArchitectureBoard\(snapshotId: string\)/);
  const intent = await createGenerationAdapter({ library: 'intent' });
  assert.throws(() => intent.compile(fixture('architecture.openui'), context()), error => error.code === 'component');
  for (const source of [
    'root=ArchitectureBoard("arch", ["invented"])',
    'root=ArchitectureBoard("arch")\nextra=ArchitectureBoard("arch")',
    'root=ArchitectureBoard("arch")\nroot=ArchitectureBoard("arch")',
  ]) assert.throws(() => adapter.compile(source, context()));
});
