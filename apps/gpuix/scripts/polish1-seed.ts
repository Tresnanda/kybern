// Polish round 1 fixture: adds to the composer-tray fixture's scratch daemon (start `composer-tray-seed.ts` with the same
// TRAY_SCRATCH first) threads for the composer shadow, the sidebar title marquee and the image morph:
// - "Shadow short" / "Shadow long": no tray, the last reply ending in the line the user saw cut above the card;
// - three threads with long titles;
// - "Images": an agent reply with an in-folder and a hidden-folder image, and a user message with two inline images.
// Only ever touches the scratch dir. Prints `seeded <json>` with the titles.
//   TRAY_SCRATCH=/Users/mymac/projects/ade-gpuix-scratch/polish1 bun scripts/polish1-seed.ts
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { KybernClient } from '../../../packages/kybern-client/src/client.ts'

const SCRATCH = process.env.TRAY_SCRATCH ?? '/Users/mymac/projects/ade-gpuix-scratch/polish1'
if (!SCRATCH.includes('gpuix-scratch')) throw new Error('TRAY_SCRATCH must be under gpuix-scratch')
const DATA = path.join(SCRATCH, 'data')
const IMAGE = path.resolve(import.meta.dir, '../../desktop/public/release-background.png')
const SQUARE = path.resolve(import.meta.dir, '../../desktop/src-tauri/icons/128x128@2x.png')
export const TITLES = {
  short: 'Shadow short',
  long: 'Shadow long',
  images: 'Images',
  marquee: [
    'Investigating kybern GPUIX 350 MB RAM usage after navigating between long threads',
    'GPUIX phase 2 perf and motion sweep: animations should be at least sixty frames per second',
    'Polish the composer tray, the sidebar title marquee and image morph transitions',
  ],
}

const token = readFileSync(path.join(DATA, 'daemon.token'), 'utf8').trim()
const port = Number(readFileSync(path.join(DATA, 'daemon.port'), 'utf8').trim())
const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token }, { createSocket: (url, t) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${t}` } } as unknown as string[]) })
await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('daemon timeout')), 15000); client.onStatus(s => { if (s === 'open') { clearTimeout(timer); resolve() } }); client.connect() })

const { threads } = await client.call('threads.list', {})
if (threads.some(t => t.title === TITLES.images)) { console.log(`seeded ${JSON.stringify(TITLES)}`); process.exit(0) }
const projects = (await client.call('projects.list', {})).projects
const project = projects[0]!
// The images the replies name: one in the thread's folder, one in a hidden folder.
mkdirSync(path.join(project.path, '.screenshots'), { recursive: true })
copyFileSync(IMAGE, path.join(project.path, 'shot.png'))
copyFileSync(SQUARE, path.join(project.path, '.screenshots', 'icon.png'))
writeFileSync(path.join(project.path, '.gitignore'), '.screenshots/\n')

const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString()
const db = new Database(path.join(DATA, 'state.sqlite'))
db.exec('PRAGMA busy_timeout = 5000')
const insert = db.prepare('INSERT INTO events(thread_id, turn_id, at, kind, payload) VALUES (?1, ?2, ?3, ?4, ?5)')
type Part = Record<string, unknown>
async function thread(title: string, turns: { user: Part[]; reply: string }[], start: number) {
  const created = await client.call('threads.create', { project_id: project.id, provider: { kind: 'claude-code', instance: 'default' }, permission_mode: 'supervised', title })
  turns.forEach(({ user, reply }, i) => {
    const turn = randomUUID(), at = start - i * 60
    insert.run(created.id, turn, ago(at), 'turn_started', JSON.stringify({ kind: 'turn_started', message_id: randomUUID(), message: { parts: user } }))
    insert.run(created.id, turn, ago(at - 5), 'assistant_message_completed', JSON.stringify({ kind: 'assistant_message_completed', message_id: randomUUID(), origin: { kind: 'root' }, text: reply, thinking: null }))
    insert.run(created.id, turn, ago(at - 10), 'turn_completed', JSON.stringify({ kind: 'turn_completed', stop_reason: 'completed', usage: { input_tokens: 1200, output_tokens: 300 }, cost_usd: null, duration_ms: 5000 }))
  })
  const last = db.query('SELECT max(seq) AS s FROM events WHERE thread_id = ?1').get(created.id) as { s: number }
  db.prepare('UPDATE threads SET last_seq = ?2, status = ?3 WHERE id = ?1').run(created.id, last.s, 'idle')
}
const text = (t: string): Part[] => [{ type: 'text', text: t }]
const LAST = 'The rebuilt addon is installed. Restart Kybern once so the new daemon picks it up; links you open from replies will keep showing as links in your installed app.'
const prose = (i: number) => `Step ${i + 1}: I read the composer, the tray and the transcript window, then measured the frame cost with the tray open.\n\n- The card shadow paints under the tray.\n- The transcript keeps its reading position.\n- Nothing presents while idle.\n\nEverything else in this pass stays as it was.`
await thread(TITLES.short, [{ user: text('Is the addon installed?'), reply: LAST }], 3000)
await thread(TITLES.long, [...Array.from({ length: 24 }, (_, i) => ({ user: text(`Continue with step ${i + 1}.`), reply: prose(i) })), { user: text('Is the addon installed?'), reply: LAST }], 6000)
for (const [i, title] of TITLES.marquee.entries()) await thread(title, [{ user: text('Hello'), reply: 'Hi.' }], 200 + i * 30)
const inline = (file: string): Part => ({ type: 'image', media_type: 'image/png', data: readFileSync(file).toString('base64') })
await thread(TITLES.images, [
  { user: [inline(IMAGE), inline(SQUARE), { type: 'text', text: 'Here are the two screenshots. What changed?' }], reply: 'The release background is wider than before:\n\n![Release background](shot.png)\n\nAnd the icon from the hidden folder:\n\n![App icon](.screenshots/icon.png)\n\nBoth still render at their natural aspect.' },
  { user: text('Thanks, and the next one?'), reply: 'Nothing else changed.' },
], 100)
db.close()
console.log(`seeded ${JSON.stringify(TITLES)}`)
process.exit(0)
