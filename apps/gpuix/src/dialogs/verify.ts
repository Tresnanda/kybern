import { launch } from '@gpuix/react/automation'
import { readFileSync } from 'node:fs'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/gpuix/environments'
const mode = process.argv[2] ?? 'dark'
const fixture = JSON.parse(readFileSync(`${out}/worktree-fixture.json`, 'utf8')) as { threadId: string }
const app = await launch({ command: 'bun', args: ['src/main.tsx'], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: mode, KYBERN_DATA_DIR: process.env.KYBERN_DATA_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/data', KYBERN_CLIENT_CONFIG_DIR: process.env.KYBERN_CLIENT_CONFIG_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/environment-client', KYBERN_GPUIX_CREDENTIALS_DIR: process.env.KYBERN_GPUIX_CREDENTIALS_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/environment-credentials', KYBERN_GPUIX_ENVIRONMENT: 'scratch-second', KYBERN_GPUIX_THREAD: fixture.threadId } })
async function click(id: string) {
  const target = app.getByTestId(id)
  await target.waitFor({ timeoutMs: 30000 })
  await app.clock.pause(); await app.clock.fastForward(350); await app.clock.resume()
  const deadline = Date.now() + 10000
  while (true) { try { await target.click(); console.log('Click', id); return } catch (e) { if (Date.now() > deadline) throw e; await new Promise((r) => setTimeout(r, 30)) } }
}
async function shot(name: string) { await app.clock.pause(); await app.clock.fastForward(350); await app.screenshot({ path: `${out}/${name}-${mode}.png` }); await app.clock.resume() }
try {
  await app.getByTestId('environment-toggle').waitFor({ timeoutMs: 60000 })
  await click('thread-actions'); await click('header-worktree-cleanup')
  await app.getByText('Source is clean.').waitFor({ timeoutMs: 15000 })
  await shot('worktree')
  if (process.env.REMOVE_FIXTURE === '1') { await click('worktree-remove'); await app.getByText('Worktree removed').waitFor({ timeoutMs: 15000 }); console.log('Scratch worktree removed through UI') }
  await click('dialog-close')
  await click('rail-settings'); await click('settings-tab-accounts'); await click('account-add')
  await app.getByTestId('account-provider').waitFor(); await shot('account')
  await click('dialog-close'); await click('settings-back')
  await click('app-menu'); await app.getByText('Add project').click()
  await app.getByTestId('project-picker-path').waitFor(); await app.getByTestId('project-picker-path').fill(process.env.KYBERN_VERIFY_PROJECT ?? '/Users/mymac/projects/ade-gpuix-scratch/environment-project')
  await click('project-picker-open'); await app.getByTestId('project-picker-parent').waitFor({ timeoutMs: 15000 }); await shot('project-picker')
  await click('project-picker-add')
  await app.getByTestId('composer').waitFor({ timeoutMs: 15000 })
  console.log('Workspace dialogs verified')
} catch (e) { await shot('dialogs-failure'); throw e } finally { await app.close() }
