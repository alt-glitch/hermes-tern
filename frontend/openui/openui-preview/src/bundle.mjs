import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, freeze, requireInput, LIBRARY_HASH } from '../../openui-generation/src/catalog.mjs';
import { projectSelection } from '../../openui-generation/src/host.mjs';
import { INTENT_LIBRARY_HASH, projectIntent } from '../../openui-generation/src/intent.mjs';
import { ARCHITECTURE_LIBRARY_HASH, projectArchitecture } from '../../openui-generation/src/architecture.mjs';
import { prepareIntentArtifact } from './intent-document.mjs';
import { prepareArchitectureArtifact } from './architecture-document.mjs';

export const MAX_BYTES = 8 * 1024 * 1024;
export const RENDERER_FILES = Object.freeze(['plugin.toml', 'host.luau', 'window.luau', 'visual.css']);
export const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const nodeId = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value);
export function exact(value, names) {
  requireInput(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...names].sort().join(','), 'shape', 'Unexpected object fields.');
}
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 160 &&
  !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e12;

/** Same repository document shape as the earlier native experiment, without its runtime. */
export function normalizeDocument(json) {
  requireInput(typeof json === 'string' && Buffer.byteLength(json) <= MAX_BYTES, 'size', 'Document exceeds 8 MiB.');
  const doc = JSON.parse(json);
  exact(doc, ['version', 'title', 'root']);
  requireInput(doc.version === 1 && text(doc.title), 'document', 'Invalid repository document.');
  const seen = new Set();
  function visit(node, depth) {
    requireInput(depth <= 16 && seen.size < 60_000, 'bounds', 'Repository tree exceeds limits.');
    exact(node, ['id', 'label', 'code', 'churn', 'children']);
    requireInput(nodeId(node.id) && !seen.has(node.id) && text(node.label), 'node', 'Invalid or duplicate node.');
    seen.add(node.id);
    requireInput(integer(node.code) && integer(node.churn) && Array.isArray(node.children), 'value', 'Invalid repository values.');
    const children = node.children.map(child => visit(child, depth + 1));
    for (const metric of ['code', 'churn']) requireInput(children.length === 0 ||
      children.reduce((sum, child) => sum + child[metric], 0) === node[metric], 'aggregate', 'Incorrect directory aggregate.');
    return { id: node.id, label: node.label, code: node.code, churn: node.churn, children };
  }
  return freeze({ version: 1, title: doc.title, root: visit(doc.root, 0) });
}

export function prepareArtifact(json, rendererHash) {
  requireInput(hash(rendererHash), 'renderer', 'Expected a renderer fingerprint.');
  const document = normalizeDocument(json);
  return freeze({ id: digest(JSON.stringify({ rendererHash, document })), rendererHash, document });
}

/** Includes actual shipped source bytes, not just version strings. No package is imported. */
export async function fingerprints() {
  const renderer = await Promise.all(RENDERER_FILES.map(async name => [name,
    digest(await readFile(new URL(`../tern/${name}`, import.meta.url)))]));
  const files = ['bundle.mjs', 'intent-document.mjs', 'architecture-document.mjs', 'lifecycle.mjs', 'control.mjs'];
  const bridge = await Promise.all(files.map(async name => [name, digest(await readFile(new URL(name, import.meta.url)))]));
  for (const name of ['adapter.mjs', 'catalog.mjs', 'host.mjs', 'intent.mjs', 'architecture.mjs', 'static-program.mjs']) {
    bridge.push([`generation/${name}`, digest(await readFile(new URL(`../../openui-generation/src/${name}`, import.meta.url)))]);
  }
  for (const name of ['architecture.v0.json', 'architecture-services.v0.json']) {
    bridge.push([`generation/fixtures/${name}`, digest(await readFile(new URL(`../../openui-generation/fixtures/${name}`, import.meta.url)))]);
  }
  bridge.push(['generation/package-lock.json', digest(await readFile(new URL('../../openui-generation/package-lock.json', import.meta.url)))]);
  return freeze({ rendererHash: digest(JSON.stringify(renderer)), bridgeHash: digest(JSON.stringify(bridge)) });
}

export function createBundle(selection, artifact, presentation, bridgeHash) {
  const body = { schema: 'hermes-openui-preview/v1', selection, artifact, presentation, bridgeHash };
  return validateBundle({ ...body, id: digest(JSON.stringify(body)) });
}

/** Stored bundles are data, never authority or visual approval. Revalidate on every host read. */
export function validateBundle(input) {
  const json = JSON.stringify(input);
  requireInput(typeof json === 'string' && Buffer.byteLength(json) <= MAX_BYTES, 'size', 'Preview bundle exceeds 8 MiB.');
  const value = JSON.parse(json);
  exact(value, ['schema', 'selection', 'artifact', 'presentation', 'bridgeHash', 'id']);
  const { id, ...body } = value;
  requireInput(value.schema === 'hermes-openui-preview/v1' && hash(id) && hash(value.bridgeHash) &&
    digest(JSON.stringify(body)) === id, 'identity', 'Preview bundle changed.');
  const s = value.selection;
  exact(s, ['schema', 'status', 'generator', 'scope', 'sourceHash', 'libraryHash', 'snapshot', 'view', 'id']);
  const { id: selectionId, ...selectionBody } = s;
  requireInput(s.schema === 'native-visual-selection/v1' && s.status === 'validated-not-verified' && hash(s.sourceHash),
    'selection', 'Selection identity or catalog changed.');
  exact(s.generator, ['core', 'adapter']);
  requireInput(typeof s.scope === 'string' && s.scope.length > 0 && s.scope.length <= 256, 'scope', 'Missing host scope.');
  exact(s.snapshot, ['key', 'id', 'rendererHash']);
  const el = (typeName, props) => ({ type: 'element', typeName, props, partial: false });
  let artifact;
  if (s.view?.kind === 'architecture-board') {
    requireInput(s.libraryHash === ARCHITECTURE_LIBRARY_HASH && digest(JSON.stringify(selectionBody)) === selectionId,
      'selection', 'Selection identity or catalog changed.');
    requireInput(s.generator.core === '@openuidev/lang-core@0.3.1' &&
      s.generator.adapter === 'bounded-architecture-selection/v0', 'generator', 'Unsupported architecture adapter.');
    exact(s.view, ['kind']);
    projectArchitecture(el('ArchitectureBoard', { snapshotId: s.snapshot.key }));
    exact(value.artifact, ['id', 'rendererHash', 'document']);
    artifact = prepareArchitectureArtifact(JSON.stringify(value.artifact.document), value.artifact.rendererHash);
  } else if (s.view?.kind === 'intent-board') {
    // Re-project through the same catalog gate the model's program passed.
    requireInput(s.libraryHash === INTENT_LIBRARY_HASH && digest(JSON.stringify(selectionBody)) === selectionId,
      'selection', 'Selection identity or catalog changed.');
    requireInput(s.generator.core === '@openuidev/lang-core@0.3.1' && s.generator.adapter === 'bounded-intent-selection/v1',
      'generator', 'Unsupported generation adapter.');
    exact(s.view, ['kind', 'sections']);
    requireInput(Array.isArray(s.view.sections), 'view', 'Unsupported view.');
    const projected = projectIntent(el('IntentBoard', { snapshotId: s.snapshot.key, sections: s.view.sections.map(section => {
      exact(section, section?.kind === 'DecisionMix' ? ['kind', 'by'] : ['kind']);
      return el(section.kind, section.kind === 'DecisionMix' ? { by: section.by } : {});
    }) }));
    requireInput(JSON.stringify(projected.sections) === JSON.stringify(s.view.sections), 'view', 'Unsupported view.');
    exact(value.artifact, ['id', 'rendererHash', 'document']);
    artifact = prepareIntentArtifact(JSON.stringify(value.artifact.document), value.artifact.rendererHash);
  } else {
    requireInput(s.libraryHash === LIBRARY_HASH && digest(JSON.stringify(selectionBody)) === selectionId,
      'selection', 'Selection identity or catalog changed.');
    requireInput(s.generator.core === '@openuidev/lang-core@0.3.1' && s.generator.adapter === 'bounded-repository-selection/v1',
      'generator', 'Unsupported generation adapter.');
    exact(s.view, ['kind', 'mode', 'metrics', 'hottestLimit', 'visibleLimit']);
    requireInput(s.view.kind === 'repo-explorer' && s.view.visibleLimit === 128, 'view', 'Unsupported view.');
    projectSelection(el('RepoExplorer', { snapshotId: s.snapshot.key, mode: s.view.mode, sections: [
      el('MetricRow', { metrics: s.view.metrics }), el('HottestFiles', { limit: s.view.hottestLimit }),
    ] }));
    exact(value.artifact, ['id', 'rendererHash', 'document']);
    artifact = prepareArtifact(JSON.stringify(value.artifact.document), value.artifact.rendererHash);
  }
  requireInput(artifact.id === value.artifact.id && artifact.id === s.snapshot.id &&
    artifact.rendererHash === s.snapshot.rendererHash, 'artifact', 'Snapshot or renderer no longer matches the selection.');
  exact(value.presentation, ['width', 'height', 'appearance']);
  const p = value.presentation;
  requireInput(Number.isInteger(p.width) && p.width >= 320 && p.width <= 2400 &&
    Number.isInteger(p.height) && p.height >= 240 && p.height <= 1800 && ['light', 'dark'].includes(p.appearance),
    'presentation', 'Invalid viewport or appearance.');
  return freeze(value);
}

export function assertCurrent(bundle, scope, current) {
  requireInput(bundle.selection.scope === scope, 'scope', 'Session/branch scope changed.');
  requireInput(bundle.artifact.rendererHash === current.rendererHash && bundle.bridgeHash === current.bridgeHash,
    'build', 'Renderer or adapter source changed; create a new preview.');
}

/** Reject symlink aliases into watched source, including not-yet-created output paths. */
export async function assertOutputDirectory(path) {
  const source = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  let ancestor = resolve(path);
  const suffix = [];
  for (;;) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
  const target = resolve(ancestor, ...suffix), rel = relative(source, target);
  requireInput(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel),
    'output-source', 'Keep snapshots/captures outside experiment and plugin source directories.');
  return target;
}
