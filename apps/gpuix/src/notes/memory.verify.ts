// Two fresh-process traversals of the same scenes. No screenshots until after
// all four measurements, so capture buffers cannot contaminate the comparison.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
const data = process.env.KYBERN_DATA_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/data'
const port = readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()
const token = readFileSync(path.join(data, 'daemon.token'), 'utf8').trim()
const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token }, { createSocket: (url, key) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${key}` } } as unknown as string[]) })
const ready = new Promise<void>((resolve) => client.onStatus((s) => { if (s === 'open') resolve() }))
client.connect(); await ready
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const ids: string[] = []
let app: Awaited<ReturnType<typeof launch>> | null = null
try {
  for (let i = 0; i < 6; i++) {
    const note = await client.call('notes.create', { scope: 'global', title: `Memory fixture ${i + 1}`, body: '## A quieter workspace\n\nIdeas and decisions worth remembering.\n\n## Next steps\n\n- [ ] Review the gallery\n- [x] Keep original Markdown\n\n```ts\nconst idea = "make room"\n\nconsole.log(idea)\n```\n' })
    ids.push(note.id)
    if (i < 2) await client.call('notes.pin', { id: note.id, pinned: true })
  }
  for (let run = 1; run <= 2; run++) {
    app = await launch({ command: 'bun', args: [path.resolve('src/main.tsx')], env: { GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: data, KYBERN_APPEARANCE: 'dark', NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH! } })
    await app.getByTestId('app-ready').waitFor({ timeoutMs: 30000 }); await pause(2000)
    const { pid } = await app.call('initialize', { protocolVersion: 1, client: 'Notes memory verification' })
    async function sample(scene: string) {
      await pause(10000)
      console.log(`RUN ${run} ${scene}`)
      const proc = Bun.spawn(['bun', 'perf/sample.ts', '15', `GPUIX=${pid}`], { stdout: 'pipe', stderr: 'pipe' })
      console.log(await new Response(proc.stdout).text())
      if (await proc.exited) throw new Error(await new Response(proc.stderr).text())
    }
    await sample('fresh Home, Notes never opened')
    await app.getByTestId('rail-notes').click(); await pause(700)
    if (await app.getByTestId('notes-back').count()) { await app.getByTestId('notes-back').click(); await pause(300) }
    await sample('gallery, six fixture notes + existing scratch notes')
    await app.getByTestId(`note-card-${ids[0]}`).click(); await pause(700)
    await sample('document, five native Markdown blocks')
    await app.getByTestId('rail-home').click(); await pause(700)
    await sample('back Home, Notes unmounted')
    // A separate diagnostic for native PNG allocation, after the comparison.
    if (run === 1 && process.env.NOTES_CAPTURE_DIAGNOSTIC) {
      for (let i = 0; i < 4; i++) await app.screenshot({ path: '/Users/mymac/projects/ade/previews/gpuix/notes/memory-capture.png' })
      await sample('Home after four screenshots')
    }
    await app.close(); app = null
  }
} finally {
  if (app) await app.close()
  for (const id of ids) { await client.call('notes.delete', { id }); await client.call('notes.purge', { id }) }
  client.close()
}
