// Decides whether slash-command output must stay monospace (ASCII tables, aligned columns,
// box drawing, colour codes) or can be read as Markdown.

const BOX = /[─-╿]/
const RULE = /^\s*\+[-=+]{3,}\+?\s*$/
// Two or more spaces between words that are not a list indent: "name      description".
const COLUMNS = /^\s{0,4}[^\s•\-*>#`|][^\n]*?\S {2,}\S/
const ESC = String.fromCharCode(27)

export function isPreformatted(text: string): boolean {
  if (text.includes(`${ESC}[`) || BOX.test(text)) {
    return true
  }

  const lines = text.split('\n').filter(l => l.trim())

  if (lines.some(l => RULE.test(l))) {
    return true
  }

  const aligned = lines.filter(l => COLUMNS.test(l)).length

  return aligned >= 3 && aligned >= lines.length / 2
}

/**
 * Command output puts one fact per line, but Markdown joins consecutive lines into a paragraph.
 * Marks each line break outside code fences as a hard break so the lines stay lines.
 */
export function hardBreaks(text: string): string {
  let fenced = false

  return text
    .split('\n')
    .map((line, i, all) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced

        return line
      }

      const next = all[i + 1]

      return fenced || !line.trim() || next === undefined || !next.trim() ? line : `${line}  `
    })
    .join('\n')
}
