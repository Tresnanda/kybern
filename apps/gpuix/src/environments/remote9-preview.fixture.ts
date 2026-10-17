// remote9: the app on an SSH environment with one thread's dock preview open on `KYBERN_PREVIEW_TARGET` (a server on
// the SSH machine). Logs native webview events and the preview entry to `KYBERN_PREVIEW_EVENTS`.
import '../main.tsx'
import { appendFileSync } from 'node:fs'
import { getState, selectThread } from '../state.ts'
import { openPreview, previewState, showPreview } from '../preview/store.ts'
import { webHost } from '../native/webview.ts'
import { activeEnvironment } from '../shell/environment.ts'
const output = process.env.KYBERN_PREVIEW_EVENTS!, thread = process.env.KYBERN_R9_THREAD!, target = process.env.KYBERN_PREVIEW_TARGET!
if (!process.env.KYBERN_DATA_DIR?.includes('ade-gpuix-scratch/phase2-remote9')) throw Error('remote9 fixture requires its scratch daemons')
const log = (event: unknown) => appendFileSync(output, JSON.stringify(event) + '\n')
webHost.subscribe(log)
const deadline = Date.now() + 40000
while (!getState().listsLoaded || getState().status !== 'open') { if (Date.now() > deadline) throw Error('remote9 preview fixture: connection timed out'); await Bun.sleep(30) }
await selectThread(thread)
showPreview(thread)
const ok = await openPreview(thread, target)
const state = previewState(thread), entry = state.entries[state.index]
log({ type: 'fixture-entry', ok, environment: activeEnvironment().id, local: activeEnvironment().local, frameUrl: entry?.frameUrl, url: entry?.url, proxy: entry?.proxy, load: state.load })
