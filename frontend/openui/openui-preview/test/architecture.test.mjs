import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bindArchitecture } from '../../openui-generation/src/architecture.mjs';
import { digest } from '../../openui-generation/src/catalog.mjs';
import { normalizeArchitectureDocument, prepareArchitectureArtifact, ARCHITECTURE_MAX_BYTES } from '../src/architecture-document.mjs';
import { createBundle, validateBundle } from '../src/bundle.mjs';
import { build } from './helpers.mjs';

const original = JSON.parse(await readFile(new URL('../fixtures/architecture-board.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);
const resign = value => { const { id, ...body } = value; return { ...body, id: digest(JSON.stringify(body)) }; };
function bundle(doc = original) {
  const artifact = prepareArchitectureArtifact(JSON.stringify(doc), build.rendererHash);
  const selection = bindArchitecture({ snapshotId: 'arch' }, 'root = ArchitectureBoard("arch")',
    { scope: 'session:branch', snapshots: new Map([['arch', artifact]]) });
  return createBundle(selection, artifact, { width: 1280, height: 900, appearance: 'dark' }, build.bridgeHash);
}

test('architecture is a read-only authored bundle, with every edge host-owned', () => {
  const value = bundle();
  assert.equal(validateBundle(clone(value)).id, value.id);
  assert.equal(value.selection.view.kind, 'architecture-board');
  assert.equal(value.artifact.document.provenance, 'authored-example');
  assert.equal(value.artifact.document.edges.length, 3);
  assert.equal('approve' in value.selection || 'execute' in value || 'publish' in value, false);
  assert.ok(Object.isFrozen(value.artifact.document.nodes[0]));
});
test('missing provenance normalizes to authored-example, not discovered infrastructure', () => {
  const doc = clone(original); delete doc.provenance;
  assert.equal(normalizeArchitectureDocument(JSON.stringify(doc)).provenance, 'authored-example');
});
const cases = [
  ['version', d => { d.v = 1; }],
  ['title empty', d => { d.title = ''; }],
  ['title whitespace', d => { d.title = ' \t '; }],
  ['title length', d => { d.title = 'a'.repeat(161); }],
  ['title control', d => { d.title = 'bad\u001b'; }],
  ['title bidi control', d => { d.title = 'bad\u202e'; }],
  ['provenance', d => { d.provenance = 'discovered'; }],
  ['missing node', d => { d.nodes = []; }],
  ['too many nodes', d => { d.nodes = Array.from({ length: 25 }, (_, i) => ({ id: 'n' + i, service: 'k3s' })); }],
  ['invalid id', d => { d.nodes[0].id = 'bad/path'; }],
  ['id length', d => { d.nodes[0].id = 'a'.repeat(41); }],
  ['duplicate id', d => { d.nodes[1].id = d.nodes[0].id; }],
  ['unknown service', d => { d.nodes[0].service = 'shell'; }],
  ['too many edges', d => { d.edges = Array.from({ length: 65 }, () => ({ from: 'browser', to: 'selector', label: 'intent' })); }],
  ['dangling source', d => { d.edges[0].from = 'absent'; }],
  ['dangling destination', d => { d.edges[0].to = 'absent'; }],
  ['self-link', d => { d.edges[0].to = d.edges[0].from; }],
  ['edge empty', d => { d.edges[0].label = ''; }],
  ['edge whitespace', d => { d.edges[0].label = '  '; }],
  ['edge length', d => { d.edges[0].label = 'x'.repeat(101); }],
  ['edge control', d => { d.edges[0].label = 'run\ncommand'; }],
  ['unknown root field', d => { d.run = 'now'; }],
  ['unknown node field', d => { d.nodes[0].verified = true; }],
  ['unknown edge field', d => { d.edges[0].approved = true; }],
  ['missing node field', d => { delete d.nodes[0].service; }],
  ['missing edge field', d => { delete d.edges[0].label; }],
];
for (const [name, alter] of cases) test('rejects ' + name, () => {
  const doc = clone(original); alter(doc);
  assert.throws(() => normalizeArchitectureDocument(JSON.stringify(doc)), error => error.code === 'shape' ||
    error.code === 'document' || error.code === 'nodes' || error.code === 'node' ||
    error.code === 'edges' || error.code === 'edge');
});
test('64-KiB bound is checked before JSON parsing', () => {
  assert.equal(ARCHITECTURE_MAX_BYTES, 65536);
  assert.throws(() => normalizeArchitectureDocument(' '.repeat(65537)), error => error.code === 'size');
});
test('resigned tampering cannot add execution authority or invent edges', () => {
  for (const edit of [
    b => { b.selection.view.action = 'apply'; },
    b => { b.selection.generator.adapter = 'bounded-intent-selection/v1'; },
    b => { b.artifact.document.edges[0].to = 'nonexistent'; },
  ]) {
    const value = clone(bundle()); edit(value);
    value.selection = resign(value.selection);
    assert.throws(() => validateBundle(resign(value)));
  }
});
