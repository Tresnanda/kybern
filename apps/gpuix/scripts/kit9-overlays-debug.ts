// Scratch probe for the overlay ports: open one overlay in the GPUIX gallery and report what is mounted.
import { startGallery } from './kit9-lib.ts'
const app = await startGallery(process.argv[2] ?? 'overlays')
try {
  const id = process.argv[3] ?? 'alert-trigger'
  console.log('trigger', JSON.stringify(await app.getByTestId(id).bounds()))
  await app.getByTestId(id).click()
  await new Promise((r) => setTimeout(r, 600))
  if (process.env.PARK) await app.mouse.move({ x: 1270, y: 810 })
  await new Promise((r) => setTimeout(r, 300))
  for (const tid of (process.argv[4] ?? 'alert-popup,alert-popup-backdrop').split(',')) {
    const n = await app.getByTestId(tid).count()
    console.log(tid, n, n ? JSON.stringify(await app.getByTestId(tid).bounds()) : '')
  }
  await app.screenshot({ path: '/private/tmp/claude-501/-Users-mymac-projects-ade/c74d51c3-9819-493a-a239-55ff0517e625/scratchpad/dbg.png' })
  console.log(JSON.stringify(await app.diagnostics?.() ?? null)?.slice(0, 2000))
} finally { await app.closeAll() }
