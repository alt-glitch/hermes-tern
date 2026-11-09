import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBundle, validateBundle } from '../src/bundle.mjs';
import { normalizeIntentDocument, prepareIntentArtifact } from '../src/intent-document.mjs';
import { bindIntent } from '../../openui-generation/src/intent.mjs';
import { digest } from '../../openui-generation/src/catalog.mjs';
import { build } from './helpers.mjs';

// Real sanitized board document produced by ephemeral-ui tools/openui-intent-doc.mjs.
const document = JSON.parse(await readFile(new URL('../fixtures/intent-board.json', import.meta.url), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const resign = value => { const { id, ...body } = value; return { ...body, id: digest(JSON.stringify(body)) }; };
const SECTIONS = [{ kind: 'DeclaredIntent' }, { kind: 'ContractGates' }, { kind: 'DecisionMix', by: 'providers' }];
function intentBundle({ doc = document, sections = SECTIONS, source = 'synthetic intent selection' } = {}) {
  const artifact = prepareIntentArtifact(JSON.stringify(doc), build.rendererHash);
  const selection = bindIntent({ snapshotId: 'z0', sections }, source, { scope: 'session-a:branch-a', snapshots: new Map([['z0', artifact]]) });
  return createBundle(selection, artifact, { width: 1280, height: 900, appearance: 'dark' }, build.bridgeHash);
}

test('intent bundle round-trips through host validation without approval fields', () => {
  const b = intentBundle();
  assert.equal(validateBundle(clone(b)).id, b.id);
  assert.equal(b.selection.view.kind, 'intent-board');
  assert.equal(b.artifact.document.contract.approval, 'pending');
  assert.equal('receipt' in b || 'approval' in b.selection, false);
});
test('section order and dimension are part of the identity', () => {
  const base = intentBundle().id;
  assert.notEqual(intentBundle({ sections: [...SECTIONS].reverse() }).id, base);
  assert.notEqual(intentBundle({ sections: [SECTIONS[0], SECTIONS[1], { kind: 'DecisionMix', by: 'status' }] }).id, base);
});
for (const [name, alter] of [
  ['an invented section', b => { b.selection.view.sections.push({ kind: 'ApproveContract' }); }],
  ['a duplicate section', b => { b.selection.view.sections.push({ kind: 'DeclaredIntent' }); }],
  ['a data prop on a section', b => { b.selection.view.sections[0].value = 1; }],
  ['an unknown dimension', b => { b.selection.view.sections[2].by = 'tokens'; }],
  ['the repository adapter identity', b => { b.selection.generator.adapter = 'bounded-repository-selection/v1'; }],
]) test(`rejects a re-signed selection with ${name}`, () => {
  const b = clone(intentBundle()); alter(b);
  b.selection = resign(b.selection); b.artifact = clone(b.artifact);
  assert.throws(() => validateBundle(resign(b)));
});
test('rejects a changed document under an old artifact id', () => {
  const b = clone(intentBundle()); b.artifact.document.intel.value.verifiedTasks = 99;
  assert.throws(() => validateBundle(resign(b)), e => e.code === 'artifact');
});
for (const [name, alter] of [
  ['approval outside the enum', d => { d.contract.approval = 'auto-approved'; }],
  ['an unknown field', d => { d.contract.onApprove = 'run'; }],
  ['a control character', d => { d.intent.sentences[0].text = 'bad\u001b[2J'; }],
  ['a fractional count', d => { d.intel.value.estimatedAvoided = 1.5; }],
  ['hits above judged rows', d => { d.intel.context.hit = d.intel.context.judged + 1; }],
  ['an unknown slice state', d => { d.work.slices[0].state = 'approved'; }],
  ['an oversized list', d => { d.contract.facts = Array.from({ length: 13 }, () => ({ text: 'x', label: 'observed' })); }],
]) test(`intent document rejects ${name}`, () => {
  const d = clone(document); alter(d);
  assert.throws(() => normalizeIntentDocument(JSON.stringify(d)));
});
test('caps intent document bytes', () => {
  assert.throws(() => normalizeIntentDocument(' '.repeat(65_537)), e => e.code === 'size');
});
