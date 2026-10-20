/** Scratch-only: add distinct large images to the newest 48 turns. */
import { Database } from 'bun:sqlite'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { gradientPng } from '../../visual/fixture.ts'
import type { seed } from '../bench/seed.ts'

export async function imageThread(fixture: Awaited<ReturnType<typeof seed>>) {
  const db = new Database(path.join(fixture.data, 'state.sqlite'))
  try {
    const events = db.query("SELECT seq,payload FROM events WHERE thread_id=? AND kind='turn_started' ORDER BY seq DESC LIMIT 48").all(fixture.manifest.long1000) as { seq: number; payload: string }[]
    const update = db.query('UPDATE events SET payload=? WHERE seq=?')
    for (const [index, event] of events.entries()) {
      const value = JSON.parse(event.payload)
      value.message.parts = [...value.message.parts.filter((part: { type: string }) => part.type !== 'image'),
        { type: 'image', media_type: 'image/png', data: gradientPng(1536 + index, 1024).toString('base64') }]
      update.run(JSON.stringify(value), event.seq)
    }
    writeFileSync(path.join(fixture.data, 'image-thread-fixture.json'), JSON.stringify({ thread: fixture.manifest.long1000, turns: 1000, imageCount: events.length, width: '1536..1583', height: 1024 }))
  } finally { db.close() }
  await fixture.restart()
}
