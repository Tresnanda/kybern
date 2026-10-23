// ADE-66: a chat link written from the agent's shell folder opens its file at the line, and a pasted image the agent read opens
// in the viewer although the harness keeps it outside the workspace. Seed first (`file-links.seed.ts`), then
//   KYBERN_DATA_DIR=<…gpuix-scratch…/data> KYBERN_VERIFY_OUTPUT=<dir> KYBERN_VERIFY_LABEL=after bun src/transcript/file-links.verify.ts
// With the daemon from before the fix it reports the failures instead of asserting, so the same run captures "before".
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { launch, type App } from '@gpuix/react/automation'

const data = process.env.KYBERN_DATA_DIR ?? ''
if (!data.includes('gpuix-scratch')) throw Error('Scratch daemon required')
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '.'
const label = process.env.KYBERN_VERIFY_LABEL ?? 'run'
const expectFixed = label !== 'before'
const scratch = path.dirname(data)

async function start(): Promise<App> {
  // No tab of an earlier run is restored.
  rmSync(path.join(data, 'gpuix-ui.json'), { force: true })
  const app = await launch({ command: 'bun', args: [path.resolve('src/main.tsx')], env: { GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_REDUCED_MOTION: '1', KYBERN_DATA_DIR: data, KYBERN_GPUIX_THREAD: 'ADE-66 links', KYBERN_CLIENT_CONFIG_DIR: path.join(scratch, 'client'), KYBERN_GPUIX_CREDENTIALS_DIR: path.join(scratch, 'creds'), NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH! } })
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 30000 })
  await Bun.sleep(2000)
  return app
}
const painted = async (app: App) => (await app.call('getPaintedText', {})).text.join('\n')
const replies = async (app: App) => (await app.getByType('markdown').all()).filter(node => node.bounds).sort((a, b) => a.bounds!.y - b.bounds!.y)
const report = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'ok ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (expectFixed) assert.ok(ok, name) }

// A link in a reply: [0] is written from the workspace root, [1] from the folder the agent's shell was in.
const only = process.env.KYBERN_VERIFY_ONLY
for (const [index, name] of [[0, 'root-link'], [1, 'shell-link']] as const) {
  if (only && only !== name) continue
  const app = await start()
  try {
    const reply = (await replies(app))[index]
    if (!reply?.bounds) await app.screenshot({ path: path.join(out, `${label}-${name}-unpainted.png`) })
    assert.ok(reply?.bounds, 'The reply with the link must be painted')
    await app.mouse.click({ x: reply.bounds.x + 30, y: reply.bounds.y + reply.bounds.height / 2 })
    await Bun.sleep(2500)
    const text = await painted(app)
    await app.screenshot({ path: path.join(out, `${label}-${name}.png`) })
    report(`${name} opens the file`, text.includes('MARKED_LINE_390'), text.includes('File not found') ? 'File not found' : '')
    report(`${name} scrolls to line 390`, text.includes('MARKED_LINE_390') && !text.includes('rows.tsx line 1\n'))
  } finally { await app.close() }
}

// The chip of the agent's Read of the user's pasted image (in the harness's session folder, outside the workspace).
if (!only || only === 'image-chip') {
  const app = await start()
  try {
    const nodes = async (prefix: string) => (await app.getByType('div').all()).filter(node => node.testId?.startsWith(prefix) && node.bounds)
    const fold = (await nodes('worked-')).find(node => !node.testId!.startsWith('worked-panel-'))
    assert.ok(fold?.bounds, 'The "Worked for" fold must be painted')
    await app.mouse.click({ x: fold.bounds.x + 20, y: fold.bounds.y + fold.bounds.height / 2 })
    await Bun.sleep(900)
    await app.screenshot({ path: path.join(out, `${label}-fold-open.png`) })
    // The run's own line ("Read 1 file") opens its chips.
    const run = (await nodes('work-run-')).find(node => !/panel|live/.test(node.testId!))
    if (run?.bounds) { await app.mouse.click({ x: run.bounds.x + 20, y: run.bounds.y + 12 }); await Bun.sleep(900) }
    await app.screenshot({ path: path.join(out, `${label}-run-open.png`) })
    const chip = (await nodes('file-chip-')).find(node => node.testId!.endsWith('/images/1.png'))
    assert.ok(chip?.bounds, 'The image chip must be painted')
    await app.mouse.click({ x: chip.bounds.x + 10, y: chip.bounds.y + chip.bounds.height / 2 })
    await Bun.sleep(1500)
    await app.screenshot({ path: path.join(out, `${label}-image-chip.png`) })
    const lightbox = (await app.getByTestId('image-lightbox').all()).length > 0
    const refused = (await app.getByTestId('thread-image-failed').all()).length > 0
    report('the image chip opens the viewer', lightbox && !refused, refused ? 'the viewer shows its refusal card' : '')
  } finally { await app.close() }
}
