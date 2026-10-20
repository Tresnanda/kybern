import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { acquirePreviewUiLock } from '../scripts/preview-ui-lock.ts'

const queue = '/tmp/kybern-gpuix-ui-queue', lane = 'loops8'
const entries = () => existsSync(queue) ? readFileSync(queue, 'utf8').split('\n').filter(Boolean) : []
export async function pacingLock() {
  const ownerRoot=path.resolve(import.meta.dir,'../../..')
  if(process.env.KYBERN_PACING_PARENT_LEASE===ownerRoot){
    if(readFileSync('/tmp/kybern-gpuix-round5-ui-lock/owner','utf8')!==ownerRoot)throw Error('Parent UI lease is no longer owned by loops8')
    return()=>{}
  }
  if (!entries().includes(lane)) appendFileSync(queue, lane+'\n')
  const deadline = Date.now()+30*60_000
  for (;;) {
    if (Date.now() >= deadline) throw Error('Timed out waiting for the loops8 UI lease')
    if (!entries().includes(lane)) appendFileSync(queue, lane+'\n')
    try {
      const first = entries()[0]
      if (first && first !== lane) { await Bun.sleep(2000); continue }
      const release = acquirePreviewUiLock()
      return () => {
        // Still hold the atomic UI lock while handing the queue to the next lane.
        writeFileSync(queue, entries().filter(value => value !== lane).join('\n')+'\n')
        release()
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw e
      await Bun.sleep(2000)
    }
  }
}
