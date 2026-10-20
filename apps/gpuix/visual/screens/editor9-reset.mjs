// Puts the editor sample note back to its seeded text over the scratch daemon's RPC, so
// screens that type leave nothing behind for the next screen (both apps share one daemon).
export const SAMPLE_FILE = '/Users/mymac/projects/ade-gpuix-scratch/phase2-editor9/visual-sample.json'

export async function rpc(url, token, calls) {
  const base = url.replace(/^ws/, 'http').replace(/\/ws$/, '')
  const response = await fetch(`${base}/session`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  const { ticket } = await response.json()
  const ws = new WebSocket(`${url}?ticket=${encodeURIComponent(ticket)}`)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let id = 0
  const pending = new Map()
  ws.onmessage = (event) => { const m = JSON.parse(String(event.data)); if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const call = (method, params) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, m => m.error ? reject(new Error(m.error.message)) : resolve(m.result)); ws.send(JSON.stringify({ jsonrpc: '2.0', id: n, method, params })) })
  try { return await calls(call) } finally { ws.close() }
}

export async function resetSample(url, token) {
  const { readFileSync } = await import('node:fs')
  const { title, body } = JSON.parse(readFileSync(SAMPLE_FILE, 'utf8'))
  await rpc(url, token, async (call) => {
    const summary = (await call('notes.list', {})).notes.find(n => n.title === title)
    if (!summary) return
    const { note } = await call('notes.get', { id: summary.id })
    if (note.body !== body) await call('notes.update', { id: note.id, expected_revision: note.revision, body })
  })
}
