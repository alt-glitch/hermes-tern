import { readFileSync } from 'node:fs';
import { digest, freeze, requireInput, LIMITS, MAX_SOURCE_BYTES } from './catalog.mjs';

// Public ephemeral-ui gh-pages at 63e06b29ffb0d7c5b9d482abebc0312335897321.
// SERVICES keys are copied as a fixture, not discovered from a runtime provider.
const serviceKeys = JSON.parse(readFileSync(new URL('../fixtures/architecture-services.v0.json', import.meta.url), 'utf8'));
requireInput(Array.isArray(serviceKeys) && serviceKeys.length === 39 &&
  serviceKeys.every(id => typeof id === 'string' && /^[a-z0-9-]+$/.test(id)) &&
  new Set(serviceKeys).size === serviceKeys.length, 'services', 'Invalid pinned architecture services.');
export const ARCHITECTURE_SERVICES = freeze(serviceKeys);
export const ARCHITECTURE_CATALOG = freeze({
  ArchitectureBoard: {
    signature: 'ArchitectureBoard(snapshotId: string)',
    description: 'Read-only authored architecture. Select the host snapshot key only; nodes, services and intent edges come entirely from its validated document. No execution, approval or publication.',
    properties: { snapshotId: { type: 'string' } },
  },
});
export const ARCHITECTURE_SCHEMA = freeze({
  properties: { ArchitectureBoard: {} },
  $defs: { ArchitectureBoard: {
    type: 'object', additionalProperties: false,
    properties: ARCHITECTURE_CATALOG.ArchitectureBoard.properties, required: ['snapshotId'],
  } },
});
export const ARCHITECTURE_LIBRARY = freeze({
  id: 'ephemeral-architecture/v0', root: 'ArchitectureBoard', schema: ARCHITECTURE_SCHEMA,
  components: { ArchitectureBoard: {
    signature: ARCHITECTURE_CATALOG.ArchitectureBoard.signature,
    description: ARCHITECTURE_CATALOG.ArchitectureBoard.description,
  } },
});
export const ARCHITECTURE_LIBRARY_HASH = digest(JSON.stringify({ ARCHITECTURE_LIBRARY, LIMITS, MAX_SOURCE_BYTES }));

export function projectArchitecture(root) {
  requireInput(root?.type === 'element' && root.typeName === 'ArchitectureBoard' &&
    root.partial === false && root.hasDynamicProps !== true, 'element', 'Expected a complete static ArchitectureBoard.');
  const props = root.props;
  requireInput(props && typeof props === 'object' && !Array.isArray(props) &&
    Object.keys(props).length === 1 && Object.hasOwn(props, 'snapshotId'), 'props', 'Only a host snapshot key is allowed.');
  requireInput(typeof props.snapshotId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(props.snapshotId),
    'snapshot', 'Expected a safe host-provided architecture snapshot key.');
  return freeze({ snapshotId: props.snapshotId });
}

export function bindArchitecture(selection, source, context) {
  requireInput(typeof context?.scope === 'string' && context.scope.length > 0 && context.scope.length <= 256,
    'scope', 'A host-owned session/branch scope is required.');
  requireInput(context.snapshots instanceof Map, 'snapshot', 'Expected a host-owned snapshot registry.');
  const snapshot = context.snapshots.get(selection.snapshotId);
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  requireInput(snapshot && hash(snapshot.id) && hash(snapshot.rendererHash),
    'snapshot', 'Unknown or invalid prepared architecture handle.');
  const handoff = {
    schema: 'native-visual-selection/v1', status: 'validated-not-verified',
    generator: { core: '@openuidev/lang-core@0.3.1', adapter: 'bounded-architecture-selection/v0' },
    scope: context.scope, sourceHash: digest(source), libraryHash: ARCHITECTURE_LIBRARY_HASH,
    snapshot: { key: selection.snapshotId, id: snapshot.id, rendererHash: snapshot.rendererHash },
    view: { kind: 'architecture-board' },
  };
  return freeze({ ...handoff, id: digest(JSON.stringify(handoff)) });
}
