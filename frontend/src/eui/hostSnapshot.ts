// Host data uses the existing EuiNode -> Tern renderer; the demo kit never sees an operation.
import type { EuiHostCardData } from '../wire/euiHostCard.js'

import type { EuiNode } from './sandbox.js'

export type HostCardStatus = 'pending' | 'running' | 'done' | 'failed'
export const HOST_APPROVE_ID = 1

/** Only plain text and a fixed native button; no model-supplied markup, style or link targets. */
export function hostSnapshot(data: EuiHostCardData, status: HostCardStatus): EuiNode {
  let next = 2
  const text = (value: string): EuiNode => ({ t: 'text', text: value })
  const el = (tag: string, kids: readonly EuiNode[], cls = '', attrs: Record<string, string> = {}): EuiNode => ({
    t: 'el', tag, id: next++, cls, style: '', attrs, click: false, kids
  })
  const kids: EuiNode[] = [
    el('h3', [text(data.title)], 'eui-host-title'),
    ...(data.summary === undefined ? [] : [el('p', [text(data.summary)])]),
    el('dl', data.rows.flatMap(row => [
      el('dt', [text(row.label)]),
      el('dd', [text(String(row.value))])
    ]), 'eui-host-rows')
  ]
  if (data.approval) {
    kids.push(el('p', [text(data.approval.description)], 'eui-host-operation'))
    kids.push({
      t: 'el', tag: 'button', id: HOST_APPROVE_ID, cls: 'eu-btn eui-host-approve', style: '',
      attrs: { 'data-eui-action': 'approve', ...(status === 'pending' ? {} : { disabled: 'true' }) },
      click: status === 'pending',
      kids: [text(status === 'pending' ? data.approval.label
        : status === 'running' ? 'Running…'
          : status === 'done' ? 'Completed' : 'Failed · approval used')]
    })
  }
  return el('div', [el('section', kids, 'eu-card eui-host')])
}
