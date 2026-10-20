import { launch, onTestDisplay, OUT } from './hr5-polish-lib.ts'
const app = await launch({ theme: 'dark', thread: 'Rounded clip review', size: process.argv[2] ?? '900x600' })
try {
  await Bun.sleep(2500)
  console.log('on test display:', onTestDisplay(app.pid))
  await app.screenshot({ path: `${OUT}/probe.png` })
} finally { await app.closeAll() }
process.exit(0)
