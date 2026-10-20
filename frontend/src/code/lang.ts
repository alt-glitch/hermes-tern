// The highlighting language of a file, by its extension.

const LANGS: Record<string, string> = {
  c: 'c',
  cpp: 'cpp',
  css: 'css',
  go: 'go',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  yaml: 'yaml',
  yml: 'yaml'
}

/** The language a `code` or `diff` node highlights `path` in; undefined for an unknown extension. */
export function langOf(path: string | undefined): string | undefined {
  const ext = path?.split('.').pop()?.toLowerCase()

  return ext ? LANGS[ext] : undefined
}
