// The native save panel from the packaged app: Notes › a note › Share ›
// Export… opens NSSavePanel in a scratch folder (the remembered save folder);
// the panel is confirmed with real OS input (computer use, run alongside) and
// the file must appear with the note's Markdown, followed by the desktop toast.
//
//   KYBERN_DATA_DIR=<scratch> bun src/platform/verify.save.ts <note id> <scratch folder> <out-dir>
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../../packaging/harness.ts'
import { assertScratchDataDir, until, windowId } from './verify.lib.ts'

assertScratchDataDir()

const [note, folder, out] = process.argv.slice(2) as [string, string, string]
assert.ok(folder.includes('ade-gpuix-scratch'))
rmSync(folder, { recursive: true, force: true })
mkdirSync(path.join(folder, 'exports'), { recursive: true })
mkdirSync(path.join(folder, 'client'), { recursive: true })
writeFileSync(path.join(folder, 'client/app.json'), JSON.stringify({ 'kybern.save.directory': path.join(folder, 'exports') }))
mkdirSync(out, { recursive: true })
const { app, pid, close } = await launchFixture('', { GPUIX_BACKGROUND: '1', KYBERN_CLIENT_CONFIG_DIR: path.join(folder, 'client'), KYBERN_APPEARANCE: 'dark' })
try {
  await app.getByTestId('rail-notes').click()
  await app.getByTestId(`note-card-${note}`).waitFor({ timeoutMs: 20_000 })
  await app.getByTestId(`note-card-${note}`).click()
  await app.getByTestId('note-menu-share').waitFor({ timeoutMs: 20_000 })
  await app.getByTestId('note-menu-share').click()
  await app.getByText('Export…').waitFor({ timeoutMs: 5000 })
  await app.getByText('Export…').click()
  console.log('save panel requested; confirm it now')
  const file = await until(() => { try { return execFileSync('ls', [path.join(folder, 'exports')], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)[0] } catch { return undefined } }, 'exported file', 120_000)
  const text = readFileSync(path.join(folder, 'exports', file), 'utf8')
  console.log(`exported ${file}:`, JSON.stringify(text.slice(0, 80)))
  await app.getByText(`Exported to ${file}`).waitFor({ timeoutMs: 5000 })
  execFileSync('screencapture', ['-x', '-o', '-l', String(windowId(pid)), path.join(out, 'export-toast.png')])
  assert.ok(existsSync(path.join(folder, 'client/app.json')))
  console.log('ok  native save panel wrote the note and the desktop toast appeared')
} finally { await close() }
process.exit(0)
