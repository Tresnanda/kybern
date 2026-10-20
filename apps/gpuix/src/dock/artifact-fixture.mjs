// Recorded Artifact tool receipts for the cards check (no real publishing tool exists in a scratch daemon).
const at = '2026-10-18T02:00:00Z'
const tool = (seq, input, output, is_error = false) => ({ seq, at, call: { id: `art-${seq}`, name: 'Artifact', input }, output, is_error })
export const ARTIFACTS = [
  tool(40, { action: 'publish', file_path: 'artifacts/dashboard.html', title: 'Sales dashboard' }, 'Published https://claude.ai/artifacts/9f2c41d0-aaaa-bbbb-cccc-0123456789ab'),
  tool(30, { action: 'publish', file_path: 'artifacts/roadmap.md' }, null),
  tool(20, { action: 'publish', file_path: 'artifacts/broken.html', title: 'Broken page' }, 'Upload rejected', true),
  tool(10, { action: 'publish', file_path: 'artifacts/notes.md', title: 'Meeting notes' }, 'ok'),
]
