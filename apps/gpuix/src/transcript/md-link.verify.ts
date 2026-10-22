// A linked Markdown file opens rendered, with "Show source" for the numbered code view (`ChatFileLink.tsx` parity).
// Needs a scratch thread titled by KYBERN_GPUIX_THREAD whose reply links to NOTES.md (a heading, bold, list, table, code).
import assert from 'node:assert/strict'
import path from 'node:path'
import { launch, type App } from '@gpuix/react/automation'

const data = process.env.KYBERN_DATA_DIR ?? ''
if (!data.includes('gpuix-scratch')) throw Error('Scratch daemon required')
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '.'
let app: App | undefined
try {
  app = await launch({ command: 'bun', args: [path.resolve('src/main.tsx')], env: { GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: data, KYBERN_GPUIX_THREAD: process.env.KYBERN_GPUIX_THREAD!, NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH! } })
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 30000 })
  await Bun.sleep(2000)
  // The reply is the lowest Markdown node ("See [NOTES.md](NOTES.md)."); the link sits after "See ".
  const reply = (await app.getByType('markdown').all()).filter(node => node.bounds).sort((a, b) => a.bounds!.y - b.bounds!.y).at(-1)
  assert.ok(reply?.bounds, 'The reply with the link must be painted')
  await app.mouse.click({ x: reply.bounds.x + 60, y: reply.bounds.y + reply.bounds.height / 2 })
  await app.getByTestId('chat-link-preview').waitFor({ timeoutMs: 10000 })
  await Bun.sleep(500)
  const painted = async () => (await app!.call('getPaintedText', {})).text.join('\n')
  assert.ok(!(await painted()).includes('# Window translucency'), 'The heading must render, not show its # marker')
  assert.ok((await painted()).includes('Window translucency'))
  await app.screenshot({ path: path.join(out, 'md-link-rendered.png') })
  await app.getByTestId('chat-link-markdown-source').click()
  await Bun.sleep(400)
  assert.ok((await painted()).includes('# Window translucency'), 'Show source shows the raw Markdown')
  await app.screenshot({ path: path.join(out, 'md-link-source.png') })
  console.log('Markdown link preview renders, and Show source shows the file')
} finally {
  await app?.close()
}
