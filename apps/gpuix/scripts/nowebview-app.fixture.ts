// The real app with the web view forced off (`KYBERN_GPUIX_NO_WEBVIEW=1`), the thread selected and a preview opened as a
// background tab. Launched by `nowebview-app-check.ts`; refuses anything but its own scratch daemon.
import '../src/main.tsx'
import { getState, selectThread } from '../src/state.ts'
import { openPreview, showPreview } from '../src/preview/store.ts'
import { openTab } from '../src/tabs/open.ts'
import { webHost } from '../src/native/webview.ts'
const thread = process.env.KYBERN_GPUIX_THREAD!, target = process.env.KYBERN_PREVIEW_TARGET
if (!process.env.KYBERN_DATA_DIR?.includes('gpuix-scratch')) throw Error('Requires a scratch daemon')
if (process.env.KYBERN_GPUIX_NO_WEBVIEW === '1' && webHost.available) throw Error('The web view should be off: set KYBERN_GPUIX_NO_WEBVIEW=1')
const deadline = Date.now() + 20000
while (!getState().listsLoaded || getState().status !== 'open') { if (Date.now() > deadline) throw Error('Connection timed out'); await Bun.sleep(30) }
await selectThread(thread)
if (target) { showPreview(thread, true); await openPreview(thread, target) }
openTab(thread, { kind: 'artifact', path: 'report.html', title: 'Report' }, { activate: false, focus: false })
