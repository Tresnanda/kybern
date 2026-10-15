/**
 * Conversation fixtures for the visual pair tool: threads whose event history is
 * written straight into the scratch daemon's SQLite store (WAL, so the running
 * daemon reads it on demand). Only ever touches the scratch data dir.
 */
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { SCRATCH, DATA_DIR } from './fixture.ts'
import type { KybernClient } from '../../../packages/kybern-client/src/client.ts'

export const CONVERSATION_IDS = path.join(SCRATCH, 'conversation-ids.json')
export type ConversationIds = Record<string, string>
export function readConversationIds(): ConversationIds {
  try { return JSON.parse(readFileSync(CONVERSATION_IDS, 'utf8')) } catch { return {} }
}

const REPLY = `Here is what I found in \`formatDate\`. The helper mixes **local** and *UTC* handling, which is why the tests fail near midnight.

## Plan

1. Normalise the input to a \`Date\` once.
2. Format through \`Intl.DateTimeFormat\` with an explicit \`timeZone\`.
3. Cover the edge cases in a table-driven test.

- Keeps the public signature
- Removes the manual padding
- See [the Intl docs](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat) for options

| Input | Zone | Output |
| --- | --- | --- |
| \`2026-10-15T23:30:00Z\` | UTC | Oct 15 |
| \`2026-10-15T23:30:00Z\` | Asia/Tokyo | Oct 16 |

\`\`\`ts
export function formatDate(input: Date | string, timeZone = 'UTC') {
  const date = typeof input === 'string' ? new Date(input) : input
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone }).format(date)
}
\`\`\`

> The old padding code is gone, so there is nothing left to drift.`

type Ev = { turn?: string; kind: string; [k: string]: unknown }

export function conversationEvents(): { title: string; events: Ev[] }[] {
  const turn1 = randomUUID(), turn2 = randomUUID()
  const m = () => randomUUID()
  const u1 = m(), a1 = m(), a2 = m(), u2 = m(), a3 = m()
  const usage = { input_tokens: 4200, output_tokens: 880, cache_read_tokens: 12000, cache_write_tokens: 300 }
  const read = { id: 'toolu_read1', name: 'Read', input: { file_path: `${SCRATCH}/kybern-app/src/date.ts` } }
  const edit = { id: 'toolu_edit1', name: 'Edit', input: { file_path: `${SCRATCH}/kybern-app/src/date.ts`, old_string: 'const pad = (n: number) => String(n).padStart(2, "0")', new_string: 'const fmt = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" })' } }
  const bash = { id: 'toolu_bash1', name: 'Bash', input: { command: 'bun test src/date.test.ts', description: 'Run the date tests' } }
  const events: Ev[] = [
    { turn: turn1, kind: 'turn_started', message_id: u1, message: { parts: [{ type: 'text', text: 'Tidy up the date helper and add a test. The tests fail near midnight.' }] } },
    { turn: turn1, kind: 'assistant_thinking_delta', message_id: a1, origin: { kind: 'root' }, delta: 'The helper pads manually and mixes local with UTC. I should read the file before changing anything.' },
    { turn: turn1, kind: 'assistant_thinking_completed', message_id: a1, origin: { kind: 'root' } },
    { turn: turn1, kind: 'assistant_message_completed', message_id: a1, origin: { kind: 'root' }, text: 'I will start by reading the helper.', thinking: 'The helper pads manually and mixes local with UTC. I should read the file before changing anything.' },
    { turn: turn1, kind: 'tool_call_started', call: read, origin: { kind: 'root' } },
    { turn: turn1, kind: 'tool_call_completed', tool_call_id: read.id, output: 'export function formatDate(d: Date) {\n  const pad = (n: number) => String(n).padStart(2, "0")\n  return `${d.getMonth() + 1}/${pad(d.getDate())}`\n}\n', is_error: false },
    { turn: turn1, kind: 'tool_call_started', call: edit, origin: { kind: 'root' } },
    { turn: turn1, kind: 'tool_call_completed', tool_call_id: edit.id, output: 'The file has been updated.', is_error: false },
    { turn: turn1, kind: 'tool_call_started', call: bash, origin: { kind: 'root' } },
    { turn: turn1, kind: 'tool_call_completed', tool_call_id: bash.id, output: 'bun test v1.2\n\nsrc/date.test.ts:\n✓ formats in UTC [1.2ms]\n✓ rolls over in Tokyo [0.4ms]\n\n 2 pass\n 0 fail', is_error: false },
    { turn: turn1, kind: 'assistant_message_completed', message_id: a2, origin: { kind: 'root' }, text: REPLY, thinking: null },
    { turn: turn1, kind: 'turn_completed', stop_reason: 'completed', usage, cost_usd: 0.0214, duration_ms: 48000, terminal_message_id: a2 },
    { turn: turn2, kind: 'turn_started', message_id: u2, message: { parts: [{ type: 'text', text: 'Thanks. Does `formatDate` handle `null`?' }] } },
    { turn: turn2, kind: 'assistant_message_completed', message_id: a3, origin: { kind: 'root' }, text: 'No. It throws on `null`; I can add a guard that returns an empty string.', thinking: null },
    { turn: turn2, kind: 'turn_completed', stop_reason: 'completed', usage, cost_usd: 0.004, duration_ms: 6000, terminal_message_id: a3 },
  ]
  return [{ title: 'Date helper cleanup', events }]
}

/** Create the conversation threads over RPC, then append their events to the store. */
export async function seed(client: KybernClient, ctx: { projects: { id: string }[] }) {
  const ids: ConversationIds = {}
  const db = new Database(path.join(DATA_DIR, 'state.sqlite'))
  db.exec('PRAGMA busy_timeout = 5000')
  for (const { title, events } of conversationEvents()) {
    const thread = await client.call('threads.create', { project_id: ctx.projects[0]!.id, provider: { kind: 'claude-code', instance: 'default' }, permission_mode: 'supervised', title })
    ids[title] = thread.id
    const insert = db.prepare('INSERT INTO events(thread_id, turn_id, at, kind, payload) VALUES (?1, ?2, ?3, ?4, ?5)')
    const start = Date.now() - 3600_000
    events.forEach((ev, i) => {
      const { turn, ...payload } = ev
      insert.run(thread.id, turn ?? null, new Date(start + i * 1500).toISOString(), ev.kind, JSON.stringify(payload))
    })
    const last = db.query('SELECT max(seq) AS s FROM events WHERE thread_id = ?1').get(thread.id) as { s: number }
    db.prepare('UPDATE threads SET last_seq = ?2, status = ?3 WHERE id = ?1').run(thread.id, last.s, 'idle')
  }
  db.close()
  writeFileSync(CONVERSATION_IDS, JSON.stringify(ids))
}

export async function ids(client: KybernClient): Promise<Record<string, unknown>> {
  const { threads } = await client.call('threads.list', {})
  return Object.fromEntries(threads.map((t) => [t.title, t.id]))
}
