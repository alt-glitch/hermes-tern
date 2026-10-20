// The execute_code tool: omp's eval card, one cell of input and its output.

import type { ToolCall } from '../../../model.js'
import { nonEmpty } from '../../format.js'
import type { Card } from '../types.js'

/** The code run and what it printed; a leading `#` comment line titles the card. */
export function evalCard(call: ToolCall, result: Record<string, unknown> | undefined): Card {
  const code = nonEmpty(call.args.code) ?? ''
  const output = nonEmpty(result?.output) ?? nonEmpty(result?.stdout) ?? call.resultText
  const error = nonEmpty(result?.error) ?? nonEmpty(result?.stderr)

  return {
    badges: [{ text: 'python' }],
    body: [
      <col key="cell-0" role="omp.tool.eval.cell">
        {/* Each side is a column that grows: without it the output gets no width and wraps one letter to a line. */}
        <row align="start" key="input" role="omp.tool.eval.input">
          <icon aria="Input" key="0" name="arrow-left" role="omp.tool.eval.prompt" />
          <col grow={1} key="source">
            <code key="code" lang="python" max={{ h: '20lines' }} numbers={false} text={code} wrap />
          </col>
        </row>
        {output || error ? (
          <row align="start" key="result" role="omp.tool.eval.result">
            <icon aria="Output" key="0" name="arrow-right" role="omp.tool.eval.prompt" />
            <col grow={1} key="outputs" role="omp.tool.eval.outputs">
              {output ? (
                <ansi follow={false} key="out" max={{ h: '20lines' }} role="omp.tool.eval.output" text={output.replace(/\n$/, '')} />
              ) : null}
              {error ? <text key="err" role="omp.tool.error" spans={[{ s: 'error', t: error }]} wrap="word" /> : null}
            </col>
          </row>
        ) : null}
      </col>
    ],
    folded: false,
    name: 'eval',
    role: 'omp.tool.eval',
    title: firstLine(code)?.startsWith('#') ? (firstLine(code)?.replace(/^#+\s*/, '') ?? 'Eval') : 'Eval'
  }
}

function firstLine(text: string | undefined): string | undefined {
  return text
    ?.split('\n')
    .find(l => l.trim())
    ?.trim()
}
