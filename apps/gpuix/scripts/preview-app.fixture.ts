import '../src/main.tsx'
import { appendFileSync } from 'node:fs'
import { getState, selectThread } from '../src/state.ts'
import { showPreview, openPreview } from '../src/preview/store.ts'
import { webHost } from '../src/native/webview.ts'
const output = process.env.KYBERN_PREVIEW_EVENTS!, thread = process.env.KYBERN_GPUIX_THREAD!, target = process.env.KYBERN_PREVIEW_TARGET!
if (!process.env.KYBERN_DATA_DIR?.includes('gpuix-scratch/round5/preview')) throw Error('Preview fixture requires its own scratch daemon')
webHost.subscribe(event => appendFileSync(output, JSON.stringify(event) + '\n'))
const deadline = Date.now() + 20000
while (!getState().listsLoaded || getState().status !== 'open') { if (Date.now() > deadline) throw Error('Preview fixture connection timed out'); await Bun.sleep(30) }
await selectThread(thread)
appendFileSync(output, JSON.stringify({ type: 'fixture-transcript', blocks: getState().open.blocks.map(block => block.kind) }) + '\n')
showPreview(thread)
await openPreview(thread, target)
