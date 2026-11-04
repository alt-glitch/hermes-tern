import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INTENT_CATALOG, INTENT_LIBRARY, SECTIONS, bindIntent, projectIntent } from '../src/intent.mjs';
import { createGenerationAdapter } from '../src/adapter.mjs';

process.env.OPENUI_TELEMETRY_DISABLED = '1';
const element = (typeName, props = {}) => ({ type: 'element', typeName, props, partial: false, hasDynamicProps: false });
const board = sections => element('IntentBoard', { snapshotId: 'z0', sections });
const context = () => ({ scope: 'session-a:branch-a', snapshots: new Map([['z0', { id: 'a'.repeat(64), rendererHash: 'b'.repeat(64) }]]) });
const bad = (fn, code) => assert.throws(fn, error => error.code === code, `expected ${code}`);
const fixture = name => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

test('catalog matches the pinned shared ephemeral-intent/v1 definition', () => {
  const shared = JSON.parse(fixture('ephemeral-intent.v1.json'));
  assert.equal(INTENT_LIBRARY.id, shared.id);
  assert.equal(INTENT_LIBRARY.root, shared.root);
  assert.deepEqual(Object.keys(INTENT_CATALOG), Object.keys(shared.components));
  for (const [name, spec] of Object.entries(shared.components)) {
    assert.equal(INTENT_CATALOG[name].signature, spec.signature, name);
    assert.equal(INTENT_CATALOG[name].description, spec.description, name);
  }
});

test('projects only a snapshot key and ordered distinct sections', () => {
  const result = projectIntent(board([element('WorkSlices'), element('DecisionMix', { by: 'providers' }), element('DeclaredIntent')]));
  assert.deepEqual(result, { snapshotId: 'z0', sections: [{ kind: 'WorkSlices' }, { kind: 'DecisionMix', by: 'providers' }, { kind: 'DeclaredIntent' }] });
  assert.ok(Object.isFrozen(result.sections[1]));
});
test('rejects duplicate sections', () => bad(() => projectIntent(board([element('TokenValue'), element('TokenValue')])), 'sections'));
test('rejects an empty board and more sections than exist', () => {
  bad(() => projectIntent(board([])), 'sections');
  bad(() => projectIntent(board([...SECTIONS, 'DeclaredIntent'].map(n => element(n, n === 'DecisionMix' ? { by: 'status' } : {})))), 'sections');
});
test('rejects a nested root, unknown sections and model-supplied data props', () => {
  bad(() => projectIntent(board([board([element('TokenValue')])])), 'element');
  bad(() => projectIntent(board([element('ApproveContract')])), 'element');
  bad(() => projectIntent(board([element('TokenValue', { value: 107971 })])), 'props');
  const root = board([element('TokenValue')]); root.props.onClick = 'approve';
  bad(() => projectIntent(root), 'props');
});
for (const by of ['tokens', '', 7]) test(`rejects DecisionMix dimension ${JSON.stringify(by)}`, () =>
  bad(() => projectIntent(board([element('DecisionMix', { by })])), 'dimension'));
for (const snapshotId of ['/tmp/x.json', 'https://x', '', 'a'.repeat(81)]) test(`rejects snapshot key ${JSON.stringify(snapshotId).slice(0, 24)}`, () =>
  bad(() => projectIntent(element('IntentBoard', { snapshotId, sections: [element('TokenValue')] })), 'snapshot'));
for (const field of ['partial', 'hasDynamicProps']) test(`rejects ${field} on a section`, () => {
  const s = element('ContractGates'); s[field] = true;
  bad(() => projectIntent(board([s])), 'element');
});

test('binds to a host handle under the intent adapter identity', () => {
  const bound = bindIntent(projectIntent(board([element('ProofReceipts')])), 'source', context());
  assert.equal(bound.generator.adapter, 'bounded-intent-selection/v1');
  assert.deepEqual(bound.view, { kind: 'intent-board', sections: [{ kind: 'ProofReceipts' }] });
  bad(() => bindIntent(projectIntent(element('IntentBoard', { snapshotId: 'missing', sections: [element('TokenValue')] })), 'x', context()), 'snapshot');
});

test('real lang-core parser: the 8-section fixture compiles; the repository library rejects it', async () => {
  const intent = await createGenerationAdapter({ library: 'intent' });
  const selection = intent.compile(fixture('intent.openui'), context());
  assert.equal(selection.view.sections.length, 8);
  assert.match(intent.prompt, /IntentBoard\(snapshotId: string, sections: Component\[\]\)/);
  const repository = await createGenerationAdapter();
  assert.throws(() => repository.compile(fixture('intent.openui'), context()), error => error.code === 'component');
});
for (const [name, source, code] of [
  ['invented component', 'root = IntentBoard("z0", [ApproveContract()])', 'component'],
  ['data literal on a section', 'root = IntentBoard("z0", [TokenValue(107971)])', 'arity'],
  ['repository component in an intent board', 'root = IntentBoard("z0", [HottestFiles(3)])', 'component'],
  ['unreachable statement', 'root = IntentBoard("z0", [TokenValue()])\nextra = WorkSlices()', 'orphan'],
]) test(`real parser rejects ${name}`, async () => {
  const intent = await createGenerationAdapter({ library: 'intent' });
  assert.throws(() => intent.compile(source, context()), error => error.code === code, `expected ${code}`);
});
test('unknown library fails closed', async () => {
  await assert.rejects(createGenerationAdapter({ library: 'html' }), error => error.code === 'library');
});
