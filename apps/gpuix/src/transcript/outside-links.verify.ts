// #220: a link to a file outside the workspace asks "Open <path> read-only?", opens it read-only after "Always allow this
// folder" (the default for the agent's scratchpad) or "Open once", and asks no more for an allowed folder. Seed first
// (`outside-links.seed.ts`), then
//   KYBERN_DATA_DIR=<…gpuix-scratch…/data> KYBERN_VERIFY_OUTPUT=<dir> bun src/transcript/outside-links.verify.ts
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launch, type App } from '@gpuix/react/automation'
import { INTRO_FILE } from '../machines/intro.ts'

const data = process.env.KYBERN_DATA_DIR ?? ''
if (!data.includes('gpuix-scratch')) throw Error('Scratch daemon required')
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '.'
const scratch = path.dirname(data)

async function start(): Promise<App> {
  // The machine network's one-time intro would cover the window: answer it "Not now".
  mkdirSync(path.join(scratch, 'client'), { recursive: true })
  writeFileSync(path.join(scratch, 'client', INTRO_FILE), JSON.stringify({ choice: 'later' }))
  rmSync(path.join(data, 'gpuix-ui.json'), { force: true })
  const app = await launch({ command: 'bun', args: [path.resolve('src/main.tsx')], env: { GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_REDUCED_MOTION: '1', KYBERN_DATA_DIR: data, KYBERN_GPUIX_THREAD: 'Outside links', KYBERN_CLIENT_CONFIG_DIR: path.join(scratch, 'client'), KYBERN_GPUIX_CREDENTIALS_DIR: path.join(scratch, 'creds') } })
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 30000 })
  await Bun.sleep(2000)
  return app
}
const painted = async (app: App) => (await app.call('getPaintedText', {})).text.join('\n')
const replies = async (app: App) => (await app.getByType('markdown').all()).filter(node => node.bounds).sort((a, b) => a.bounds!.y - b.bounds!.y)
const exists = async (app: App, id: string) => { try { await app.getByTestId(id).waitFor({ timeoutMs: 3000 }); return true } catch { return false } }
const clickLink = async (app: App, index: number) => {
  const reply = (await replies(app))[index]
  if (!reply?.bounds) await app.screenshot({ path: path.join(out, 'unpainted.png') })
  assert.ok(reply?.bounds, 'The reply with the link must be painted')
  await app.mouse.click({ x: reply.bounds.x + (index === 0 ? 100 : 135), y: reply.bounds.y + 10 })
  await Bun.sleep(800)
}
const report = (name: string, ok: boolean) => { console.log(`${ok ? 'ok ' : 'FAIL'} ${name}`); assert.ok(ok, name) }

const app = await start()
try {
  // The scratchpad's file: the folder is the default choice, and the file opens read-only.
  await clickLink(app, 0)
  report('the scratchpad link asks first', await exists(app, 'outside-file'))
  await app.screenshot({ path: path.join(out, 'prompt-scratchpad.png') })
  await app.getByTestId('outside-file-folder').click()
  await Bun.sleep(1500)
  let text = await painted(app)
  report('it opens read-only', text.includes('Read-only') && text.includes('Written by the agent'))
  await app.screenshot({ path: path.join(out, 'opened-read-only.png') })
  // The same folder asks no more.
  await clickLink(app, 0)
  report('an allowed folder opens without asking', !(await exists(app, 'outside-file')))
  // A file in another folder: "Open once" is the default.
  await app.getByTestId('tab-chat').click()
  await Bun.sleep(600)
  await clickLink(app, 1)
  report('the other link asks first', await exists(app, 'outside-file'))
  await app.screenshot({ path: path.join(out, 'prompt-other-folder.png') })
  await app.getByTestId('outside-file-once').click()
  await Bun.sleep(1500)
  text = await painted(app)
  report('it opens read-only too', text.includes('Read-only') && text.includes('A file in another folder'))
} finally { await app.close() }
