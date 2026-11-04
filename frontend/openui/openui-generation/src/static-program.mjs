import { CATALOG, LIMITS, MAX_SOURCE_BYTES, VisualInputError, requireInput } from './catalog.mjs';

/** Resource/lexical gate only. OpenUI itself still tokenizes and parses the program. */
export function checkSource(source) {
  requireInput(typeof source === 'string' && source.trim().length > 0, 'source', 'Expected a nonempty OpenUI program.');
  requireInput(Buffer.byteLength(source, 'utf8') <= MAX_SOURCE_BYTES, 'size', 'OpenUI source exceeds 32 KiB.');
  const outside = source.replace(/"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/g, literal => {
    requireInput(JSON.parse(literal).length <= 256, 'string', 'Literal strings are limited to 256 characters.');
    return 's';
  });
  // The upstream lexer tolerates unknown characters and malformed strings. P0 must
  // fail closed instead of accepting a repaired/dropped source as fully verified.
  requireInput(/^[A-Za-z0-9_=(),\[\]\s]*$/.test(outside) && !/[^ \t\r\n\x21-\x7e]/.test(outside),
    'static-subset', 'Only double-quoted JSON strings, integers, references, arrays and catalog calls are enabled.');
  const stack = [];
  const closing = { ')': '(', ']': '[' };
  for (const char of outside) {
    if (char === '(' || char === '[') stack.push(char);
    if (char === ')' || char === ']') requireInput(stack.pop() === closing[char], 'incomplete', 'Unmatched delimiter.');
    requireInput(stack.length <= LIMITS.depth, 'depth', 'OpenUI nesting exceeds the experiment limit.');
  }
  requireInput(stack.length === 0, 'incomplete', 'Unfinished OpenUI program.');
}

/** Serialize only the accepted AST subset, never execute it. */
function emit(node, refs, budget, catalog) {
  requireInput(node && typeof node === 'object' && --budget.left >= 0, 'nodes', 'OpenUI AST exceeds the experiment limit.');
  switch (node.k) {
    case 'Str': return JSON.stringify(node.v);
    case 'Num':
      requireInput(Number.isSafeInteger(node.v) && node.v >= 0 && node.v <= LIMITS.visible,
        'number', 'Only small nonnegative integer literals are needed by this catalog.');
      return String(node.v);
    case 'Ref':
      requireInput(/^[a-z][A-Za-z0-9_]{0,63}$/.test(node.n), 'reference', 'Invalid static reference.');
      refs.push(node.n);
      return node.n;
    case 'Arr': return `[${node.els.map(child => emit(child, refs, budget, catalog)).join(',')}]`;
    case 'Comp': {
      requireInput(Object.hasOwn(catalog, node.name) && !node.mappedProps,
        'component', `Unsupported component: ${node.name}.`);
      const arity = Object.keys(catalog[node.name].properties).length;
      requireInput(node.args.length === arity, 'arity', `${node.name} requires exactly ${arity} arguments.`);
      return `${node.name}(${node.args.map(child => emit(child, refs, budget, catalog)).join(',')})`;
    }
    default: throw new VisualInputError('static-subset', 'Runtime expressions, state, builtins and actions are disabled.');
  }
}

function checkReferenceGraph(statements) {
  let remaining = LIMITS.nodes;
  const reached = new Set();
  function visit(id, active) {
    requireInput(statements.has(id), 'unresolved', `Unresolved reference: ${id}.`);
    requireInput(!active.has(id), 'cycle', 'Cyclic statement references are not supported.');
    requireInput(active.size < LIMITS.depth, 'depth', 'Reference expansion is too deep.');
    const statement = statements.get(id);
    remaining -= statement.cost;
    requireInput(remaining >= 0, 'expansion', 'Expanded OpenUI tree is too large.');
    reached.add(id);
    const next = new Set(active).add(id);
    for (const ref of statement.refs) visit(ref, next);
  }
  visit('root', new Set());
  requireInput(reached.size === statements.size, 'orphan', 'Every statement must be reachable from root.');
}

/** catalog: the active library's components (defaults to the repository catalog). */
export function checkProgram(core, source, catalog = CATALOG) {
  checkSource(source);
  const tokens = core.tokenize(source);
  const raw = core.split(tokens);
  requireInput(raw.length > 0 && raw.length <= LIMITS.statements, 'statements', 'Expected 1–32 statements.');
  const statements = new Map();
  const canonical = [];
  const budget = { left: LIMITS.nodes };
  for (const statement of raw) {
    requireInput(/^[a-z][A-Za-z0-9_]{0,63}$/.test(statement.id), 'statement-id', 'Use lowercase static statement identifiers.');
    requireInput(!statements.has(statement.id), 'duplicate', `Duplicate statement: ${statement.id}.`);
    const refs = [];
    const before = budget.left;
    const expression = emit(core.parseExpression(statement.tokens), refs, budget, catalog);
    statements.set(statement.id, { refs, cost: before - budget.left });
    canonical.push(`${statement.id}=${expression}`);
  }
  // Re-tokenizing the accepted AST catches trailing expressions, missing commas,
  // skipped statements and parser recovery. No private enum values are copied.
  const newline = core.tokenize('\n')[0].t;
  const eof = core.tokenize('')[0].t;
  const significant = input => input.filter(token => token.t !== newline && token.t !== eof);
  requireInput(JSON.stringify(significant(tokens)) === JSON.stringify(significant(core.tokenize(canonical.join('\n')))),
    'recovery', 'The parser skipped or repaired part of the program.');
  checkReferenceGraph(statements);
  return statements.size;
}
