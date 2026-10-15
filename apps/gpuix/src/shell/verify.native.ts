import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { launchFixture, waitForPainted } from '../requests/harness.ts'
const mode = process.argv[2] ?? 'dark'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/gpuix/p2'
mkdirSync(out, { recursive: true })
const f = await launchFixture(path.resolve(process.argv.includes('--close') ? 'src/shell/verify.running.ts' : 'src/main.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: process.argv.includes('--theme') ? '' : mode })
const app = f.app
const click = async (id: string) => { await app.getByTestId(id).waitFor({ timeoutMs: 30000 }); await app.getByTestId(id).click(); await app.clock.fastForward(350) }
try {
  await app.getByTestId('environment-toggle').waitFor({ timeoutMs: 60000 })
  if (process.argv.includes('--theme')) {
    for (let i = 0; i < 2; i++) {
      const root = await app.getByTestId('app-ready').element()
      await app.call('keyDown', { elementId: root.id, key: 'cmd-k' })
      await app.getByTestId('palette-input').waitFor()
      await app.getByTestId('palette-input').fill('Toggle theme')
      await click('palette-item-theme')
      await app.screenshot({ path: `${out}/theme-live-${i}.png` })
    }
    console.log('PASS two live theme toggles via palette')
  } else if (process.argv.includes('--close')) {
    const root = await app.getByTestId('app-ready').element()
    console.log('Request close')
    await app.call('keyDown', { elementId: root.id, key: 'cmd-w' })
    await app.getByTestId('close-guard').waitFor()
    console.log('Guard mounted')
    await waitForPainted(app, 'still working')
    await app.clock.fastForward(350)
    await app.screenshot({ path: `${out}/close-guard-${mode}.png` })
    console.log('Captured guard'); await click('close-guard-cancel'); console.log('Cancelled')
    if (await app.getByTestId('close-guard').count()) throw Error('Cancel did not dismiss')
    await app.getByTestId('app-ready').click()
    await app.call('keyDown', { elementId: root.id, key: 'cmd-w' })
    console.log('Requested again')
    await app.getByTestId('close-guard').waitFor()
    console.log('PASS close guard veto, cancel, repeat close')
    await click(process.argv.includes('--stop') ? 'close-guard-stop' : 'close-guard-close').catch(() => {})
  } else {
    await click('thread-actions'); await click('header-worktree-cleanup')
    await waitForPainted(app, 'Source is clean.')
    await app.screenshot({ path: `${out}/worktree-${mode}.png` })
    await click('dialog-close')
    await click('environment-toggle')
    await app.getByTestId('environment-branch').waitFor({ timeoutMs: 15000 })
    await app.screenshot({ path: `${out}/environment-${mode}.png` })
    await click('environment-sections'); await click('environment-section-editor')
    if (await app.getByTestId('environment-editor').count()) throw Error('Editor remained visible')
    await click('environment-section-editor')
    await app.getByTestId('environment-editor').waitFor()
    console.log('PASS workspace cleanup, no-checkpoint branch, section preferences')
  }
} finally { console.log(f.diagnostics()); await f.close() }
