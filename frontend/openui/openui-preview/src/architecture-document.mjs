import { ARCHITECTURE_SERVICES } from '../../openui-generation/src/architecture.mjs';
import { digest, freeze, requireInput } from '../../openui-generation/src/catalog.mjs';

// Authored examples only; v0 is not a live cloud/infrastructure inventory.
export const ARCHITECTURE_MAX_BYTES = 65_536;
const services = new Set(ARCHITECTURE_SERVICES);
const id = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(value);
const text = (value, max) => typeof value === 'string' && value.length >= 1 &&
  value.length <= max && value.trim().length > 0 &&
  !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value);
function fields(value, required, optional = []) {
  requireInput(value && typeof value === 'object' && !Array.isArray(value) &&
    required.every(k => Object.hasOwn(value, k)) &&
    Object.keys(value).every(k => required.includes(k) || optional.includes(k)),
    'shape', 'Unknown or missing architecture fields.');
}

export function normalizeArchitectureDocument(json) {
  requireInput(typeof json === 'string' && Buffer.byteLength(json) <= ARCHITECTURE_MAX_BYTES,
    'size', 'Architecture document exceeds 64 KiB.');
  const doc = JSON.parse(json);
  fields(doc, ['v', 'title', 'nodes', 'edges'], ['provenance']);
  requireInput(doc.v === 0 && text(doc.title, 160) &&
    (!Object.hasOwn(doc, 'provenance') || doc.provenance === 'authored-example'),
    'document', 'Expected authored-example architecture v0 with a valid title.');
  requireInput(Array.isArray(doc.nodes) && doc.nodes.length >= 1 && doc.nodes.length <= 24,
    'nodes', 'Architecture needs 1 to 24 nodes.');
  requireInput(Array.isArray(doc.edges) && doc.edges.length <= 64,
    'edges', 'Architecture allows at most 64 intent edges.');
  const seen = new Set();
  const nodes = doc.nodes.map(node => {
    fields(node, ['id', 'service']);
    requireInput(id(node.id) && !seen.has(node.id) && services.has(node.service),
      'node', 'Nodes require a unique safe id and a pinned service.');
    seen.add(node.id);
    return { id: node.id, service: node.service };
  });
  const edges = doc.edges.map(edge => {
    fields(edge, ['from', 'to', 'label']);
    requireInput(seen.has(edge.from) && seen.has(edge.to) && edge.from !== edge.to &&
      text(edge.label, 100), 'edge', 'An intent edge needs different existing endpoints and a label of 1 to 100 characters.');
    return { from: edge.from, to: edge.to, label: edge.label };
  });
  return freeze({ v: 0, title: doc.title, provenance: 'authored-example', nodes, edges });
}

export function prepareArchitectureArtifact(json, rendererHash) {
  requireInput(typeof rendererHash === 'string' && /^[a-f0-9]{64}$/.test(rendererHash),
    'renderer', 'Expected a renderer fingerprint.');
  const document = normalizeArchitectureDocument(json);
  return freeze({ id: digest(JSON.stringify({ rendererHash, document })), rendererHash, document });
}
