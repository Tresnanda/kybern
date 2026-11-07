// The integration patches are historical: these changes are in the app already.
// Use the supported compiler CLI; TypeScript 7 no longer exposes a JS compiler host.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['exec', 'tsc', '--noEmit'], {
  cwd: path.resolve(import.meta.dir, '..'), stdio: 'inherit',
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
