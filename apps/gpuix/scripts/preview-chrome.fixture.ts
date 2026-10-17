import '../src/main.tsx'
import { appendFileSync } from 'node:fs'
import { getState, selectThread } from '../src/state.ts'
import { showPreview, openPreview, previewState, subscribePreviews } from '../src/preview/store.ts'
import { webHost } from '../src/native/webview.ts'
import { addWindowKeyHandler } from '../src/nav/keys.ts'
const output = process.env.KYBERN_PREVIEW_EVENTS!, thread = process.env.KYBERN_GPUIX_THREAD!, target = process.env.KYBERN_PREVIEW_TARGET!
if (!process.env.KYBERN_DATA_DIR?.includes('gpuix-scratch/round6/preview')) throw Error('Preview chrome fixture requires its own scratch daemon')
const log = (data: unknown) => appendFileSync(output, JSON.stringify(data) + '\n')
webHost.subscribe(log)
subscribePreviews(() => { const s = previewState(thread); log({ type: 'state', loading: s.loading, busy: s.busy, phase: s.load.phase, pagePath: s.pagePath, address: s.entries[s.index]?.address, proxy: s.entries[s.index]?.proxy }) })
addWindowKeyHandler(event => {
  if (!event.modifiers?.ctrl || !event.modifiers.alt) return
  if (event.key === 'g') { webHost.post(`preview:${thread}`, `document.querySelector('iframe').contentWindow.postMessage({kind:'fixture-next'},'*')`); return true }
})
const deadline = Date.now() + 20000
while (!getState().listsLoaded || getState().status !== 'open') { if (Date.now() > deadline) throw Error('Preview fixture connection timed out'); await Bun.sleep(30) }
await selectThread(thread); showPreview(thread); await openPreview(thread, target)
