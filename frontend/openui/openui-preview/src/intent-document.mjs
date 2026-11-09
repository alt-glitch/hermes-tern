import { digest, freeze, requireInput } from '../../openui-generation/src/catalog.mjs';

// Host document behind ephemeral-intent/v1, built by ephemeral-ui tools/openui-intent-doc.mjs
// from the sanitized intent snapshot. Revalidated field by field; unknown fields fail closed.
export const INTENT_MAX_BYTES = 65_536;
const LIST = 12;
const exact = (value, names) => requireInput(value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...names].sort().join(','), 'shape', 'Unexpected intent document fields.');
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 400 &&
  !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e12;
const hex = value => typeof value === 'string' && /^[a-f0-9]{10,64}$/.test(value);
const stamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(value);
const one = (value, allowed) => allowed.includes(value);
function list(value, item, max = LIST) {
  requireInput(Array.isArray(value) && value.length <= max, 'list', 'Intent document list exceeds its bound.');
  return value.map(item);
}
const rows = value => list(value, row => {
  exact(row, ['label', 'value']);
  requireInput(text(row.label) && count(row.value), 'value', 'Invalid ranked row.');
  return { label: row.label, value: row.value };
}, 8);

export function normalizeIntentDocument(json) {
  requireInput(typeof json === 'string' && Buffer.byteLength(json) <= INTENT_MAX_BYTES, 'size', 'Intent document exceeds 64 KiB.');
  const doc = JSON.parse(json);
  exact(doc, ['version', 'title', 'intent', 'contract', 'work', 'intel']);
  requireInput(doc.version === 1 && text(doc.title), 'document', 'Invalid intent document.');
  const { intent, contract, work, intel } = doc;
  exact(intent, ['revision', 'sourceHash', 'sentences']);
  requireInput(count(intent.revision) && hex(intent.sourceHash), 'intent', 'Invalid declared intent.');
  exact(contract, ['approval', 'contractHash', 'preconditions', 'acceptance', 'facts']);
  requireInput(one(contract.approval, ['pending', 'approved', 'rejected']) && hex(contract.contractHash), 'contract', 'Invalid contract.');
  exact(contract.acceptance, ['receipt', 'clauses']);
  requireInput(one(contract.acceptance.receipt, ['missing', 'present']), 'contract', 'Invalid acceptance receipt state.');
  exact(work, ['slices']);
  exact(intel, ['decisions', 'value', 'context', 'health']);
  const { decisions, value, context, health } = intel;
  exact(decisions, ['rows', 'last', 'execution', 'providers', 'status']);
  requireInput(count(decisions.rows) && stamp(decisions.last), 'intel', 'Invalid decision summary.');
  exact(value, ['estimatedAvoided', 'pairedRows', 'reportedSaved', 'verifiedTasks']);
  requireInput(Object.values(value).every(count), 'intel', 'Invalid token value counts.');
  exact(context, ['episodes', 'imported', 'predictions', 'judged', 'hit', 'top1']);
  requireInput(['episodes', 'imported', 'predictions', 'judged', 'hit'].every(k => count(context[k])) && context.hit <= context.judged,
    'intel', 'Invalid context counts.');
  exact(health, ['ok', 'backends']);
  requireInput(typeof health.ok === 'boolean', 'intel', 'Invalid health flag.');
  return freeze({
    version: 1, title: doc.title,
    intent: { revision: intent.revision, sourceHash: intent.sourceHash, sentences: list(intent.sentences, s => {
      exact(s, ['text', 'role']); requireInput(text(s.text) && one(s.role, ['task', 'context']), 'intent', 'Invalid sentence.');
      return { text: s.text, role: s.role };
    }, 8) },
    contract: {
      approval: contract.approval, contractHash: contract.contractHash,
      preconditions: list(contract.preconditions, p => {
        exact(p, ['label', 'state']); requireInput(text(p.label) && one(p.state, ['pass', 'changed', 'unknown']), 'contract', 'Invalid precondition.');
        return { label: p.label, state: p.state };
      }),
      acceptance: { receipt: contract.acceptance.receipt, clauses: list(contract.acceptance.clauses, c => {
        requireInput(text(c), 'contract', 'Invalid acceptance clause.'); return c;
      }) },
      facts: list(contract.facts, f => {
        exact(f, ['text', 'label']); requireInput(text(f.text) && one(f.label, ['observed', 'claimed']), 'contract', 'Invalid fact.');
        return { text: f.text, label: f.label };
      }),
    },
    work: { slices: list(work.slices, s => {
      exact(s, ['id', 'title', 'where', 'state']);
      requireInput(/^[A-Za-z0-9_-]{1,16}$/.test(s.id) && text(s.title) && text(s.where) &&
        one(s.state, ['built', 'not-started', 'blocked', 'in-progress', 'done']), 'work', 'Invalid slice.');
      return { id: s.id, title: s.title, where: s.where, state: s.state };
    }) },
    intel: {
      decisions: { rows: decisions.rows, last: decisions.last, execution: rows(decisions.execution), providers: rows(decisions.providers), status: rows(decisions.status) },
      value: { ...value },
      context: { episodes: context.episodes, imported: context.imported, predictions: context.predictions, judged: context.judged, hit: context.hit, top1: rows(context.top1) },
      health: { ok: health.ok, backends: list(health.backends, b => {
        exact(b, ['id', 'ready', 'local']);
        requireInput(/^[A-Za-z0-9_.-]{1,64}$/.test(b.id) && typeof b.ready === 'boolean' && typeof b.local === 'boolean', 'intel', 'Invalid backend.');
        return { id: b.id, ready: b.ready, local: b.local };
      }) },
    },
  });
}

export function prepareIntentArtifact(json, rendererHash) {
  requireInput(typeof rendererHash === 'string' && /^[a-f0-9]{64}$/.test(rendererHash), 'renderer', 'Expected a renderer fingerprint.');
  const document = normalizeIntentDocument(json);
  return freeze({ id: digest(JSON.stringify({ rendererHash, document })), rendererHash, document });
}
