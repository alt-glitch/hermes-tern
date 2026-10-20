// The execute_code tool: omp's eval card, one cell of input and its output.

import type { ToolCall } from '../../../model.js'
import type { EvalDetail } from '../../../tools/misc.js'
import { flat } from '../../format.js'
import type { Card, ToolView } from '../types.js'

/** The execute_code tool's view: its step is the gateway's line for the script. */
export const evalView: ToolView<'execute_code'> = {
  action: 'command',
  card: evalCard,
  hubIcon: 'python',
  step: call => (call.context ? flat(call.context) : 'Ran a script')
}

/** The code run and what it printed; a leading `#` comment line titles the card. */
function evalCard(call: ToolCall, d: EvalDetail): Card {
  const code = d.code ?? ''
  const output = d.output ?? call.resultText
  const error = d.error

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
