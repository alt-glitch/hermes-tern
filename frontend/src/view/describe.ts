// A shell command as a short human title ("Run vq7.ps1 on vespyr", "Search for 'TODO'"), for
// tool card heads. The command itself stays one click away in the card's body; this only has
// to say what the step is for, in a few words, without a model call.

/** How long a title may get before it is cut. */
const MAX = 72

/** Words of a shell segment: quotes removed, backslash escapes kept as written. */
function words(segment: string): string[] {
  const out: string[] = []
  const re = /'([^']*)'|"((?:\\.|[^"\\])*)"|(\S+)/g

  for (const m of segment.matchAll(re)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '')
  }

  return out
}

const base = (path: string) => path.replace(/\/+$/, '').split(/[/\\]/).at(-1) || path
const quote = (s: string) => `'${clip(s, 32)}'`
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The first argument that is not a flag (and not a flag's value, for the flags listed). */
function operand(args: readonly string[], valued: ReadonlySet<string> = new Set()): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!

    if (valued.has(a)) {
      i++
    } else if (!a.startsWith('-') || a === '-') {
      return a
    }
  }

  return undefined
}

const operands = (args: readonly string[]) => args.filter(a => !a.startsWith('-'))

const GIT: Record<string, string> = {
  add: 'Stage changes',
  blame: 'Blame',
  branch: 'List branches',
  checkout: 'Switch branch',
  'cherry-pick': 'Cherry-pick',
  clone: 'Clone repository',
  commit: 'Commit',
  diff: 'Diff changes',
  fetch: 'Fetch',
  log: 'Read git history',
  merge: 'Merge',
  pull: 'Pull',
  push: 'Push',
  rebase: 'Rebase',
  remote: 'List remotes',
  reset: 'Reset',
  restore: 'Restore files',
  'rev-parse': 'Resolve revision',
  show: 'Show commit',
  stash: 'Stash changes',
  status: 'Check git status',
  switch: 'Switch branch',
  worktree: 'Manage worktrees'
}

type Describer = (args: string[]) => string | undefined

const COMMANDS: Record<string, Describer> = {
  cat: a => (operand(a) ? `Read ${base(operand(a)!)}` : 'Read input'),
  cd: a => `Go to ${base(operand(a) ?? '~')}`,
  chmod: a => `Change mode of ${base(operands(a).at(-1) ?? 'files')}`,
  cp: a => `Copy ${base(operands(a)[0] ?? 'files')}`,
  curl: a => {
    const url = a.find(x => /^https?:\/\//.test(x))

    return url ? `Fetch ${new URL(url).host}` : 'Fetch a URL'
  },
  docker: a => `Docker ${operand(a) ?? ''}`.trim(),
  echo: () => 'Print text',
  fd: a => (operand(a) ? `Find ${quote(operand(a)!)}` : 'Find files'),
  find: a => {
    const name = a[a.indexOf('-name') + 1]

    return a.includes('-name') && name ? `Find ${quote(name)}` : `Find files in ${base(operand(a) ?? '.')}`
  },
  // A shell loop names no purpose of its own; its body's steps are past a `;`.
  for: () => 'Run a loop',
  gh: a => `GitHub ${operands(a).slice(0, 2).join(' ')}`.trim(),
  git: a => {
    const sub = operand(a, new Set(['-C', '-c']))

    return sub ? (GIT[sub] ?? `Git ${sub}`) : 'Git'
  },
  grep: a => searchTitle(a),
  head: a => (operand(a, new Set(['-n', '-c'])) ? `Read the start of ${base(operand(a, new Set(['-n', '-c']))!)}` : 'Read the start'),
  kill: () => 'Stop a process',
  less: a => `Read ${base(operand(a) ?? 'output')}`,
  ls: a => `List ${base(operand(a) ?? 'files')}`,
  make: a => `Make ${operand(a) ?? ''}`.trim(),
  mkdir: a => `Create ${base(operands(a).at(-1) ?? 'a folder')}`,
  mv: a => `Move ${base(operands(a)[0] ?? 'files')}`,
  node: a => (operand(a) ? `Run ${base(operand(a)!)}` : 'Run Node'),
  npm: a => npmTitle(a),
  npx: a => `Run ${operand(a) ?? 'a package'}`,
  pkill: a => `Stop ${operand(a) ?? 'processes'}`,
  pnpm: a => npmTitle(a),
  powershell: a => powershellTitle(a),
  ps: () => 'List processes',
  pwsh: a => powershellTitle(a),
  python: a => pythonTitle(a),
  python3: a => pythonTitle(a),
  rg: a => searchTitle(a),
  rm: a => `Delete ${base(operands(a).at(-1) ?? 'files')}`,
  scp: a => `Copy ${base(operands(a)[0] ?? 'files')} to ${hostOf(operands(a).at(-1) ?? '') ?? 'a host'}`,
  bash: a => shellTitle(a),
  sed: a => (a.includes('-i') ? `Edit ${base(operands(a).at(-1) ?? 'a file')}` : `Read ${base(operands(a).at(-1) ?? 'a file')}`),
  sh: a => shellTitle(a),
  sleep: a => `Wait ${operand(a) ?? ''}s`.replace(' s', ''),
  sort: () => 'Sort output',
  tail: a => (a.includes('-f') ? `Follow ${base(operands(a).at(-1) ?? 'a log')}` : `Read the end of ${base(operands(a).at(-1) ?? 'output')}`),
  tern: a => `Tern ${operands(a).slice(0, 2).join(' ')}`.trim(),
  touch: a => `Create ${base(operands(a).at(-1) ?? 'a file')}`,
  until: () => 'Run a loop',
  uv: a => (a[0] === 'run' ? (pythonTitle(a.slice(1).filter(x => x !== 'python')) ?? 'Run with uv') : `uv ${operand(a) ?? ''}`.trim()),
  vitest: () => 'Run tests',
  wc: a => `Count lines in ${base(operands(a).at(-1) ?? 'files')}`,
  while: () => 'Run a loop',
  zsh: a => shellTitle(a),
  which: a => `Locate ${operand(a) ?? 'a command'}`
}

function shellTitle(a: string[]): string {
  const script = operand(a, new Set(['-c', '-o']))

  return a.includes('-c') ? 'Run a shell snippet' : script ? `Run ${base(script)}` : 'Run a shell'
}

function searchTitle(a: string[]): string {
  const pattern = operand(a, new Set(['-e', '-g', '--glob', '-t', '--type', '-A', '-B', '-C', '-m']))
  const where = operands(a).at(-1)
  const target = where && where !== pattern ? ` in ${base(where)}` : ''

  return pattern ? `Search for ${quote(pattern)}${target}` : 'Search'
}

function npmTitle(a: string[]): string {
  const [sub, script] = operands(a)

  if (sub === 'run' && script) {
    return /test/.test(script) ? 'Run tests' : `Run ${script}`
  }

  return sub === 'test' ? 'Run tests' : sub === 'install' || sub === 'i' || sub === 'ci' ? 'Install packages' : `npm ${sub ?? ''}`.trim()
}

function pythonTitle(a: string[]): string {
  const m = a.indexOf('-m')

  if (m >= 0 && a[m + 1]) {
    return a[m + 1] === 'pytest' ? 'Run tests' : `Run ${a[m + 1]}`
  }

  if (a.includes('-c') || a.includes('-')) {
    return 'Run Python'
  }

  const script = operand(a)

  return script ? `Run ${base(script)}` : 'Run Python'
}

function powershellTitle(a: string[]): string {
  const file = a[a.findIndex(x => /^-file$/i.test(x)) + 1]

  return a.some(x => /^-file$/i.test(x)) && file ? `Run ${base(file)}` : 'Run PowerShell'
}

/** What PowerShell cmdlets do, by verb-noun. */
const CMDLETS: Record<string, string> = {
  'get-childitem': 'list files',
  'get-content': 'read files',
  'get-counter': 'read counters',
  'get-itemproperty': 'read the registry',
  'get-process': 'list processes',
  'get-service': 'list services',
  'get-winevent': 'read the event log',
  'remove-item': 'delete files',
  'set-content': 'write files',
  'start-process': 'start a process',
  'stop-process': 'stop a process'
}

/** A PowerShell script by the cmdlets it uses: "List files and list processes". */
function powershellScript(text: string): string | undefined {
  const used = [...new Set([...text.matchAll(/\b([A-Z][a-z]+-[A-Z][A-Za-z]+)\b/g)].map(m => m[1]!.toLowerCase()))]
  const said = [...new Set(used.map(c => CMDLETS[c] ?? (c.startsWith('get-') ? `read ${c.slice(4)}` : undefined)).filter(Boolean))]

  return said.length ? said.slice(0, 2).join(' and ') : undefined
}

/** `user@host:path` or `user@host` → `host`. */
function hostOf(target: string): string | undefined {
  const m = /^(?:[^@\s]+@)?([A-Za-z0-9][\w.-]*):/.exec(target) ?? /^[^@\s]+@([\w.-]+)$/.exec(target)

  return m?.[1]
}

/** Section labels a script prints for itself (`"== saves =="`, `echo '--- disk ---'`, `# Check disk`). */
function sections(script: string): string[] {
  const out: string[] = []

  for (const line of script.split('\n')) {
    const m =
      /^\s*(?:echo\s+|Write-Host\s+)?["']?\s*(?:={2,}|-{3,}|#{2,})\s*(.+?)\s*(?:={2,}|-{3,}|#{2,})\s*["']?\s*$/.exec(line) ??
      /^\s*#\s+([A-Z][^#]{3,60})$/.exec(line)

    if (m?.[1] && !/^!/.test(m[1])) {
      out.push(m[1].replace(/\s+/g, ' '))
    }
  }

  return out
}

/** One segment of a chain (`a && b; c | d` gives a, b, c, d) without env assignments or sudo. */
function head(segment: string): { cmd: string; raw: string; args: string[] } | undefined {
  const w = words(segment)

  while (w.length && (/^[A-Za-z_]\w*=/.test(w[0]!) || w[0] === 'sudo' || w[0] === 'env' || w[0] === 'time' || w[0] === 'exec')) {
    w.shift()
  }

  const cmd = w.shift()

  return cmd ? { args: w, cmd: base(cmd), raw: cmd } : undefined
}

/** Top-level segments of a command line, split on `&&`, `||`, `;`, `|` and newlines outside quotes. */
function segments(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let q: string | undefined

  for (let i = 0; i < line.length; i++) {
    const c = line[i]!

    if (q) {
      cur += c

      if (c === q && line[i - 1] !== '\\') {
        q = undefined
      }
    } else if (c === "'" || c === '"') {
      q = c
      cur += c
    } else if (c === '\n' || c === ';' || c === '|' || (c === '&' && line[i + 1] === '&')) {
      out.push(cur)
      cur = ''

      if (line[i + 1] === c) {
        i++
      }
    } else {
      cur += c
    }
  }

  out.push(cur)

  return out.map(s => s.trim()).filter(Boolean)
}

/** Steps that only set up the real one: they never name a command's purpose. */
const SETUP = new Set(['cd', 'export', 'set', 'source', '.', 'true', 'clear', 'pushd', 'popd'])

/** Commands that only shape another command's output. */
const FILTERS = new Set(['head', 'tail', 'grep', 'sort', 'uniq', 'wc', 'cut', 'tr', 'awk', 'jq', 'tee', 'column', 'less', 'cat', 'xargs', 'sed'])

/**
 * A command line as a short title. Heredoc scripts shipped to a host and run there read as
 * "Run vq7.ps1 on vespyr: saves, pagefile +2"; `ssh host 'cmd'` as "<cmd's title> on host";
 * chains by their first real step.
 */
export function describeCommand(command: string): string {
  const text = command.trim()

  if (!text) {
    return 'Run a command'
  }

  // Heredoc bodies are data, not steps: take them out, keep their section labels.
  const docs: string[] = []
  const line = text.replace(/<<-?\s*['"]?(\w+)['"]?([^\n]*)\n([\s\S]*?)\n\s*\1\s*(?=\n|$)/g, (_m, _tag, rest: string, body: string) => {
    docs.push(body)

    return rest
  })

  const labels = docs.flatMap(sections)
  const steps = segments(line).flatMap(s => head(s) ?? [])
  const real = steps.filter(s => !SETUP.has(s.cmd))
  const remote = real.find(s => s.cmd === 'ssh')
  let title: string | undefined

  if (remote) {
    const host = operand(remote.args, new Set(['-p', '-i', '-o', '-l', '-J', '-F']))?.replace(/^[^@]+@/, '')
    const after = remote.args.slice(remote.args.findIndex(a => a.replace(/^[^@]+@/, '') === host) + 1).join(' ')
    const inner = after ? describeCommand(after) : 'Open a shell'

    title = host ? `${inner} on ${host}` : inner
  } else {
    // A pipeline is named by its producer; `grep` & co. only shape what it printed.
    const main = real.find(s => !FILTERS.has(s.cmd)) ?? real[0]
    const ps = main && !COMMANDS[main.cmd] && /^\$|^[A-Z][a-z]+-[A-Z]/.test(main.raw) ? powershellScript(line) : undefined

    title = ps ? ps : main ? (COMMANDS[main.cmd]?.(main.args) ?? `Run ${main.cmd}`) : steps[0] ? `Run ${steps[0].cmd}` : undefined
  }

  title ??= 'Run a command'

  if (labels.length) {
    // Two labels when they fit, else the first and a count.
    const two = `${title}: ${labels.slice(0, 2).join(', ')}${labels.length > 2 ? ` +${labels.length - 2}` : ''}`

    title = two.length <= MAX ? two : `${title}: ${clip(labels[0]!, 32)}${labels.length > 1 ? ` +${labels.length - 1}` : ''}`
  } else if (docs.length && /^Read input|^Read /.test(title) && real[0]?.cmd === 'cat') {
    // `cat > file <<EOF` alone writes a file.
    title = `Write ${base(operands(real[0].args).at(-1) ?? 'a file')}`
  }

  return clip(title.charAt(0).toUpperCase() + title.slice(1), MAX)
}

/** `cmd` on one line, cut to `n` characters: the card head's view of the command. */
export function commandLine(command: string, n = 96): string {
  const flat = command.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\s*\1\s*(?=\n|$)/g, "<<'$1' …").replace(/\s+/g, ' ').trim()

  return clip(flat, n)
}
