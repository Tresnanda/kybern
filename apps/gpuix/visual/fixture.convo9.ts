/**
 * Markdown block-rhythm fixtures for the convo9 lane: one finished assistant
 * answer per thread, written straight into the scratch daemon's store like
 * fixture.conversation.ts. Only ever touches the scratch data dir.
 */
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { DATA_DIR } from './fixture.ts'
import type { KybernClient } from '../../../packages/kybern-client/src/client.ts'

export const BLOCKS_A = `Here is a tour of block types. This paragraph runs straight into the code block below it, which is where the spacing was too tight.
\`\`\`sh
cd ~/projects/ade-gpuix/apps/gpuix
pnpm dev
\`\`\`
The paragraph after the code block starts here and should have the desktop's rhythm above it.

## A heading after prose

Text under the heading, with **bold**, *italic*, \`inline code\` and a [link](https://example.com/docs).

### A smaller heading

Text under the smaller heading.

\`\`\`ts
const alone = 'a code block between paragraphs'
\`\`\`

Closing paragraph.`

export const BLOCKS_B = `Paragraph before a bullet list.

- First bullet
- Second bullet with a longer line that wraps onto a second line so the list item gap and the indentation are visible in the comparison
  - Nested bullet
  - Another nested bullet
- Third bullet

1. Ordered one
2. Ordered two
3. Ordered three

Paragraph between lists.

> A quote follows the paragraph and has its own rhythm.

Paragraph after the quote.`

export const BLOCKS_C = `A table follows.

| Input | Zone | Output |
| --- | --- | --- |
| \`2026-10-15T23:30:00Z\` | UTC | Oct 15 |
| \`2026-10-15T23:30:00Z\` | Asia/Tokyo | Oct 16 |

\`\`\`ts
export function formatDate(input: Date | string, timeZone = 'UTC') {
  return new Intl.DateTimeFormat('en', { timeZone }).format(new Date(input))
}
\`\`\`

\`\`\`ts
const second = 'two code blocks in a row'
\`\`\`

---

#### Level four

Final paragraph after a rule.`

export const MERMAID = `A diagram of the flow:

\`\`\`mermaid
flowchart LR
  A[Composer] --> B{Send}
  B -->|Enter| C[Daemon]
  B -->|Queue| D[Queued]
  C --> E[Provider]
\`\`\`

And some text after it.`

export async function seed(client: KybernClient, ctx: { projects: { id: string }[] }) {
  const db = new Database(path.join(DATA_DIR, 'state.sqlite'))
  db.exec('PRAGMA busy_timeout = 5000')
  const usage = { input_tokens: 4200, output_tokens: 880, cache_read_tokens: 12000, cache_write_tokens: 300 }
  for (const [title, text] of [['Markdown A', BLOCKS_A], ['Markdown B', BLOCKS_B], ['Markdown C', BLOCKS_C], ['Mermaid diagram', MERMAID]] as const) {
    const thread = await client.call('threads.create', { project_id: ctx.projects[0]!.id, provider: { kind: 'claude-code', instance: 'default' }, permission_mode: 'supervised', title })
    const turn = randomUUID(), answer = randomUUID()
    const events = [
      { turn, kind: 'turn_started', message_id: randomUUID(), message: { parts: [{ type: 'text', text: 'Show me every block type.' }] } },
      { turn, kind: 'assistant_message_completed', message_id: answer, origin: { kind: 'root' }, text, thinking: null },
      { turn, kind: 'turn_completed', stop_reason: 'completed', usage, cost_usd: 0.004, duration_ms: 6000, terminal_message_id: answer },
    ]
    const insert = db.prepare('INSERT INTO events(thread_id, turn_id, at, kind, payload) VALUES (?1, ?2, ?3, ?4, ?5)')
    const start = Date.now() - 3600_000
    events.forEach((ev, i) => { const { turn: t, ...payload } = ev; insert.run(thread.id, t, new Date(start + i * 1500).toISOString(), ev.kind, JSON.stringify(payload)) })
    const last = db.query('SELECT max(seq) AS s FROM events WHERE thread_id = ?1').get(thread.id) as { s: number }
    db.prepare('UPDATE threads SET last_seq = ?2, status = ?3 WHERE id = ?1').run(thread.id, last.s ?? 0, 'idle')
  }
  // A published visual reply: the daemon serves it in a sandboxed frame.
  const visual = await client.call('threads.create', { project_id: ctx.projects[0]!.id, provider: { kind: 'claude-code', instance: 'default' }, permission_mode: 'supervised', title: 'Visual reply' })
  {
    const turn = randomUUID(), answer = randomUUID()
    const events = [
      { turn, kind: 'turn_started', message_id: randomUUID(), message: { parts: [{ type: 'text', text: 'Chart the merged pull requests.' }] } },
      { turn, kind: 'assistant_message_completed', message_id: answer, origin: { kind: 'root' }, text: 'Here is the chart.', thinking: null },
      { turn, kind: 'turn_completed', stop_reason: 'completed', usage, cost_usd: 0.004, duration_ms: 6000, terminal_message_id: answer },
    ]
    const insert = db.prepare('INSERT INTO events(thread_id, turn_id, at, kind, payload) VALUES (?1, ?2, ?3, ?4, ?5)')
    const start = Date.now() - 3600_000
    events.forEach((ev, i) => { const { turn: t, ...payload } = ev; insert.run(visual.id, t, new Date(start + i * 1500).toISOString(), ev.kind, JSON.stringify(payload)) })
    const last = db.query('SELECT max(seq) AS s FROM events WHERE thread_id = ?1').get(visual.id) as { s: number }
    db.prepare('UPDATE threads SET last_seq = ?2, status = ?3 WHERE id = ?1').run(visual.id, last.s ?? 0, 'idle')
  }
  await client.call('threads.visuals.publish', { thread_id: visual.id, title: 'Weekly merges', height: 260, html: `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:14px system-ui,sans-serif;margin:0;padding:16px;color:var(--foreground,#222)}
.bar{display:flex;align-items:center;gap:8px;margin:6px 0}.bar i{display:block;height:18px;border-radius:4px;background:#4a8bf5}
h2{font-size:15px;margin:0 0 8px}
</style></head><body><h2>Merged pull requests per week</h2>
${[['Week 1', 120], ['Week 2', 200], ['Week 3', 160], ['Week 4', 260]].map(([label, width]) => `<div class="bar"><span style="width:56px">${label}</span><i style="width:${width}px"></i></div>`).join('')}
</body></html>` })
  db.close()
}

export async function ids(client: KybernClient): Promise<Record<string, unknown>> {
  const { threads } = await client.call('threads.list', {})
  return Object.fromEntries(threads.map(t => [t.title, t.id]))
}
