// On-screen check for older-history paging: scroll a long delegating thread to the top and count how many
// wheel gestures bring new prompts into view. Needs a scratch daemon whose data holds such a thread.
import assert from 'node:assert/strict'
import path from 'node:path'
import { launch, type App } from '@gpuix/react/automation'

const data = process.env.KYBERN_DATA_DIR ?? ''
if (!data.includes('gpuix-scratch')) throw Error('Scratch daemon required')
const thread = process.env.KYBERN_GPUIX_THREAD ?? ''
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '.'
const gestures = Number(process.env.GESTURES ?? 24)
let app: App | undefined
try {
  app = await launch({ command: 'sh', args: ['-c', `exec bun ${path.resolve('src/main.tsx')} 2>>${process.env.APP_LOG ?? '/dev/null'}`], env: { GPUIX_BACKGROUND: '1', KYBERN_STARTUP_TRACE: process.env.KYBERN_STARTUP_TRACE ?? '0', KYBERN_DATA_DIR: data, KYBERN_GPUIX_THREAD: thread, NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH! } })
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 30000 })
  await app.getByTestId('transcript').waitFor({ timeoutMs: 20000 })
  await Bun.sleep(2500)
  const painted = async () => (await app!.call('getPaintedText', {})).text.join('\n')
  const seen = new Set<string>()
  // Each mounted prompt bubble is a distinct node; a bubble seen once counts once.
  const prompts = async () => (await app!.getByTestId('user-bubble').all().catch(() => [])).map(n => String(n.id))
  for (const p of await prompts()) seen.add(p)
  let fresh = 0, idle = 0
  const t0 = performance.now()
  for (let g = 0; g < gestures; g++) {
    const before = seen.size, text = await painted()
    await app.mouse.wheel({ x: 1100, y: 500 }, 0, 8000) // positive deltaY scrolls toward the top
    await Bun.sleep(700)
    for (const p of await prompts()) seen.add(p)
    const changed = (await painted()) !== text
    if (seen.size > before) fresh++
    else if (!changed) idle++
    console.log(`gesture ${g + 1}: prompts seen ${seen.size} (${seen.size - before >= 0 ? '+' + (seen.size - before) : ''}), view ${changed ? 'moved' : 'unchanged'}`)
    if (g === 5) await app.screenshot({ path: path.join(out, 'paging-window-mid.png') })
  }
  await app.screenshot({ path: path.join(out, 'paging-window-end.png') })
  const earlierHint = (await painted()).includes('Scroll up for earlier messages')
  console.log(`AT_START ${!earlierHint}`)
  console.log(`RESULT gestures=${gestures} withNewPrompt=${fresh} unchanged=${idle} prompts=${seen.size} seconds=${((performance.now() - t0) / 1000).toFixed(1)}`)
  assert.ok(fresh >= Math.min(5, gestures / 4), 'Scrolling up should keep bringing earlier prompts into view')
} finally {
  await app?.close()
}
