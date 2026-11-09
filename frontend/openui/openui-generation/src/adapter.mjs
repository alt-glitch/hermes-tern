import { LIBRARY, SCHEMA, CATALOG, freeze, assertTelemetryDisabled, loadCore, requireInput } from './catalog.mjs';
import { bindSelection, projectSelection } from './host.mjs';
import { INTENT_CATALOG, INTENT_LIBRARY, INTENT_SCHEMA, bindIntent, projectIntent } from './intent.mjs';
import { ARCHITECTURE_CATALOG, ARCHITECTURE_LIBRARY, ARCHITECTURE_SCHEMA, bindArchitecture, projectArchitecture } from './architecture.mjs';
import { checkProgram } from './static-program.mjs';

const RULES = [
  'This experiment permits only catalog calls, arrays, small nonnegative integer literals, double-quoted JSON strings and static references.',
  'Define root. Every declaration must be reachable from root. No comments, fences, objects, operators, state, queries, mutations, actions or builtin calls.',
];
// One entry per reviewed native view. The model selects; host code owns data and interaction.
const LIBRARIES = {
  repository: {
    library: LIBRARY, schema: SCHEMA, catalog: CATALOG, root: 'RepoExplorer', project: projectSelection, bind: bindSelection,
    rules: [
      'Use only snapshot keys supplied in the task. Repository measurements are host-owned; select metric keys, never fabricate data.',
      'Include exactly one MetricRow and one HottestFiles. Local interaction behavior belongs to reviewed native code, not generated handlers.',
    ],
  },
  intent: {
    library: INTENT_LIBRARY, schema: INTENT_SCHEMA, catalog: INTENT_CATALOG, root: 'IntentBoard', project: projectIntent, bind: bindIntent,
    rules: [
      'Use only snapshot keys supplied in the task. Intent, contract, receipt and intelligence values are host-owned; select sections, never fabricate data.',
      'Each section appears at most once. Approval stays with the host: no section approves, executes or publishes anything.',
    ],
  },
  architecture: {
    library: ARCHITECTURE_LIBRARY, schema: ARCHITECTURE_SCHEMA, catalog: ARCHITECTURE_CATALOG,
    root: 'ArchitectureBoard', project: projectArchitecture, bind: bindArchitecture,
    rules: [
      'Only the host-approved authored architecture snapshot key may be selected. All nodes and intent edges are host-owned.',
      'Every edge expresses unverified design intent. Do not infer infrastructure integrations, provide actions or approve, execute or publish anything.',
    ],
  },
};

export async function createGenerationAdapter({ library = 'repository' } = {}) {
  const spec = LIBRARIES[library];
  requireInput(spec, 'library', `Unknown OpenUI library: ${library}.`);
  const core = await loadCore();
  const parser = core.createParser(spec.schema, spec.root);
  // The catalog prompt is generated once, not rebuilt for each snapshot or reply.
  const prompt = core.generateSystemPrompt({
    library: spec.library,
    promptOptions: { toolCalls: false, bindings: false, editMode: false, inlineMode: false, additionalRules: [...RULES, ...spec.rules] },
  });

  function compile(source, context) {
    assertTelemetryDisabled();
    const count = checkProgram(core, source, spec.catalog);
    const result = parser.parse(source);
    const meta = result.meta;
    requireInput(meta?.incomplete === false && meta.statementCount === count &&
      Array.isArray(meta.errors) && meta.errors.length === 0 &&
      Array.isArray(meta.unresolved) && meta.unresolved.length === 0 &&
      Array.isArray(meta.orphaned) && meta.orphaned.length === 0,
      'parse', 'The complete program must parse without recovery, omissions or unresolved references.');
    requireInput(Object.keys(result.stateDeclarations ?? {}).length === 0 &&
      (result.queryStatements ?? []).length === 0 && (result.mutationStatements ?? []).length === 0,
      'static-subset', 'State, queries and mutations are disabled.');
    return spec.bind(spec.project(result.root), source, context);
  }

  return freeze({ prompt, compile });
}
