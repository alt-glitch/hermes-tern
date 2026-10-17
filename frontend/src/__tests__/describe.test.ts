import { describe, expect, it } from 'vitest'

import { commandLine, describeCommand } from '../view/describe.js'

describe('describeCommand', () => {
  it('names a heredoc script shipped to a host by the script, the host and its sections', () => {
    const cmd = `cat > /Users/sid/.hermes/cache/scratch/vq7.ps1 <<'EOF'
"== steam userdata 3669870 =="
Get-ChildItem 'C:\\Program Files (x86)\\Steam\\userdata' -Directory
"== explorer/dwm running in session 1? =="
Get-Process explorer,dwm
"== commit peak since boot =="
(Get-Counter '\\Memory\\Committed Bytes')
EOF
scp -q /Users/sid/.hermes/cache/scratch/vq7.ps1 sidbin@vespyr:vq7.ps1 && ssh sidbin@vespyr 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\\Users\\sidbin\\vq7.ps1' 2>&1 | cut -c1-220`

    expect(describeCommand(cmd)).toBe('Run vq7.ps1 on vespyr: steam userdata 3669870 +2')
  })

  it('names a shell loop as a loop, not by its keyword', () => {
    expect(describeCommand('for i in $(seq 1 90); do echo tick $i; sleep 1; done')).toBe('Run a loop')
    expect(describeCommand('while true; do date; sleep 5; done')).toBe('Run a loop')
  })

  it('names an inline PowerShell one-liner over ssh by its cmdlets', () => {
    const cmd = `ssh sidbin@vespyr '$lib="C:\\Program Files (x86)\\Steam\\steamapps"; Get-ChildItem "$lib\\appmanifest_*.acf" | % { $t=Get-Content $_ -Raw }; Get-Process steam' 2>&1`

    expect(describeCommand(cmd)).toBe('List files and read files on vespyr')
  })

  it('names common commands by what they do', () => {
    expect(describeCommand('git log --oneline -3')).toBe('Read git history')
    expect(describeCommand('git -C ~/repo status -sb')).toBe('Check git status')
    expect(describeCommand('rg -n "TODO" src')).toBe("Search for 'TODO' in src")
    expect(describeCommand('cd frontend && npm run check')).toBe('Run check')
    expect(describeCommand('npx vitest run')).toBe('Run vitest')
    expect(describeCommand('uv run python scripts/build.py --fast')).toBe('Run build.py')
    expect(describeCommand('python -m pytest tests/')).toBe('Run tests')
    expect(describeCommand('curl -s https://example.com/api | jq .')).toBe('Fetch example.com')
    expect(describeCommand('ls -la ~/github')).toBe('List github')
    expect(describeCommand('sleep 4')).toBe('Wait 4s')
    expect(describeCommand("cat > /tmp/x.sh <<'EOF'\necho \"== disk ==\"\nEOF\nsh /tmp/x.sh 2>&1 | cut -c1-9")).toBe('Run x.sh: disk')
  })

  it('names a pipeline by its producer, not its filters', () => {
    expect(describeCommand('ps aux | grep node | head -5')).toBe('List processes')
    expect(describeCommand('cat package.json | jq .version')).toBe('Read package.json')
  })

  it('reads a bare heredoc to a file as a write', () => {
    expect(describeCommand("cat > notes.md <<'EOF'\nhello\nEOF")).toBe('Write notes.md')
  })

  it('keeps unknown commands readable and short', () => {
    expect(describeCommand('frobnicate --hard thing')).toBe('Run frobnicate')
    expect(describeCommand('')).toBe('Run a command')
    expect(describeCommand(`ssh host '${'x'.repeat(300)}'`).length).toBeLessThanOrEqual(72)
  })
})

describe('commandLine', () => {
  it('flattens a command to one line and folds heredoc bodies', () => {
    expect(commandLine("cat > a.ps1 <<'EOF'\nline one\nline two\nEOF\nscp a.ps1 h:a.ps1")).toBe("cat > a.ps1 <<'EOF' … scp a.ps1 h:a.ps1")
    expect(commandLine('x'.repeat(200), 20)).toHaveLength(20)
  })
})
