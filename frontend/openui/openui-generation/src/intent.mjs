import { digest, freeze, requireInput, LIMITS, MAX_SOURCE_BYTES } from './catalog.mjs';

// Shared definition: ephemeral-ui integration/openui/ephemeral-intent.v1.json (pinned copy in
// fixtures/, checked by test/intent.test.mjs). Property insertion order is positional order.
// The model selects a snapshot key and sections; every shown value comes from the host document.
const section = (signature, description) => ({ signature, description, properties: {} });
export const DECISION_DIMENSIONS = Object.freeze(['execution', 'providers', 'status']);
export const INTENT_CATALOG = freeze({
  IntentBoard: {
    signature: 'IntentBoard(snapshotId: string, sections: Component[])',
    description: 'Root. Select one host-provided intent snapshot key and 1 to 8 distinct sections, in display order. Never invent snapshot keys or data.',
    properties: { snapshotId: { type: 'string' }, sections: { type: 'array', items: {} } },
  },
  DeclaredIntent: section('DeclaredIntent()', 'The exact asked words, split into the task and its context, with the immutable source hash.'),
  ContractGates: section('ContractGates()', 'Approval state, observed preconditions and acceptance clauses of the pending intent contract.'),
  WorkSlices: section('WorkSlices()', "The contract's implementation slices and their observed state. Implementation is not acceptance."),
  ProofReceipts: section('ProofReceipts()', 'Whether the real-turn acceptance receipt exists, and the preconditions observed for it.'),
  DecisionMix: {
    signature: 'DecisionMix(by: "execution" | "providers" | "status")',
    description: 'z0intelligence decision events broken down by one host-computed dimension.',
    properties: { by: { type: 'string', enum: DECISION_DIMENSIONS } },
  },
  TokenValue: section('TokenValue()', 'Estimated vs measured vs verified token value, kept apart.'),
  ContextFlow: section('ContextFlow()', 'Next-context prediction episodes and family top-1 on labeled rows.'),
  RuntimeHealth: section('RuntimeHealth()', 'Which capture-environment backends are ready.'),
});
export const SECTIONS = Object.freeze(Object.keys(INTENT_CATALOG).filter(name => name !== 'IntentBoard'));
export const INTENT_SCHEMA = freeze({
  properties: Object.fromEntries(Object.keys(INTENT_CATALOG).map(name => [name, {}])),
  $defs: Object.fromEntries(Object.entries(INTENT_CATALOG).map(([name, spec]) => [name, {
    type: 'object', additionalProperties: false, properties: spec.properties, required: Object.keys(spec.properties),
  }])),
});
export const INTENT_LIBRARY = freeze({
  id: 'ephemeral-intent/v1', root: 'IntentBoard', schema: INTENT_SCHEMA,
  components: Object.fromEntries(Object.entries(INTENT_CATALOG).map(([name, { signature, description }]) => [name, { signature, description }])),
});
export const INTENT_LIBRARY_HASH = digest(JSON.stringify({ INTENT_LIBRARY, LIMITS, MAX_SOURCE_BYTES }));

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const key = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);

function component(node, names) {
  requireInput(node?.type === 'element' && names.includes(node.typeName) && node.partial === false && node.hasDynamicProps !== true,
    'element', `Expected a complete static ${names.length === 1 ? names[0] : 'intent section'}.`);
  const props = node.props;
  requireInput(props && typeof props === 'object' && !Array.isArray(props), 'props', 'Expected named component properties.');
  const expected = Object.keys(INTENT_CATALOG[node.typeName].properties).sort();
  requireInput(JSON.stringify(Object.keys(props).sort()) === JSON.stringify(expected), 'props', `Unexpected ${node.typeName} properties.`);
  return props;
}

/** Converts only selection/composition: a snapshot key and an ordered set of distinct sections. */
export function projectIntent(root) {
  const props = component(root, ['IntentBoard']);
  requireInput(key(props.snapshotId), 'snapshot', 'Use a host-provided snapshot key, not a path or URL.');
  requireInput(Array.isArray(props.sections) && props.sections.length >= 1 && props.sections.length <= SECTIONS.length,
    'sections', `Select 1 to ${SECTIONS.length} sections.`);
  const sections = props.sections.map(node => {
    const p = component(node, SECTIONS);
    if (node.typeName !== 'DecisionMix') return { kind: node.typeName };
    requireInput(DECISION_DIMENSIONS.includes(p.by), 'dimension', 'DecisionMix.by must be execution, providers or status.');
    return { kind: 'DecisionMix', by: p.by };
  });
  requireInput(new Set(sections.map(s => s.kind)).size === sections.length, 'sections', 'Sections must be distinct.');
  return freeze({ snapshotId: props.snapshotId, sections });
}

/** Bind to a host-scoped prepared intent artifact handle, without copying its document. */
export function bindIntent(selection, source, context) {
  requireInput(typeof context?.scope === 'string' && context.scope.length > 0 && context.scope.length <= 256,
    'scope', 'A host-owned session/branch scope is required.');
  requireInput(context.snapshots instanceof Map, 'snapshot', 'Expected a host-owned snapshot registry.');
  const snapshot = context.snapshots.get(selection.snapshotId);
  requireInput(snapshot && hash(snapshot.id) && hash(snapshot.rendererHash), 'snapshot', 'Unknown or invalid prepared-artifact handle.');
  const handoff = {
    schema: 'native-visual-selection/v1', status: 'validated-not-verified',
    generator: { core: '@openuidev/lang-core@0.3.1', adapter: 'bounded-intent-selection/v1' },
    scope: context.scope, sourceHash: digest(source), libraryHash: INTENT_LIBRARY_HASH,
    snapshot: { key: selection.snapshotId, id: snapshot.id, rendererHash: snapshot.rendererHash },
    view: { kind: 'intent-board', sections: selection.sections.map(s => ({ ...s })) },
  };
  return freeze({ ...handoff, id: digest(JSON.stringify(handoff)) });
}
