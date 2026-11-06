// Synthetic values only; callbacks in the tests operate solely on in-memory counters.
export function approvalCard() {
  return {
    kind: 'approve', app: 'glide', title: 'Prepare local workspace',
    summary: 'Review the local operation.',
    rows: [{ label: 'Files', value: 3 }, { label: 'Downloads', value: false }],
    approval: { label: 'Create workspace', description: 'Create only the three reviewed local files.' }
  }
}
