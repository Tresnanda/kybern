// Instrumentation is confined to this entry point, before React loads.
import type { Pointer } from 'bun:ffi'
import path from 'node:path'
process.env.GPUIX_BACKGROUND='1'
if (process.env.KYBERN_PACING_BASELINE === '1') {
  const root = path.resolve(import.meta.dir, '../../..')
  Bun.plugin({ name: 'pacing-before-source', setup(build) {
    build.onLoad({ filter: /\/src\/(MatrixLoader\.tsx|tasks\/Glyphs\.tsx|shell\/Connection\.tsx|transcript\/(motion|Turn)\.tsx)$/ }, args => {
      const file = path.relative(root, args.path)
      const result = Bun.spawnSync(['git', 'show', `b6f5d7ee:${file}`], { cwd: root })
      if (result.exitCode) throw Error(result.stderr.toString())
      return { contents: result.stdout.toString(), loader: 'tsx' }
    })
  } })
}
;(globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true, renderers: new Map(),
  inject() { return 1 },
  onCommitFiberRoot() { console.error('[pacing-commit]', performance.now()) },
  onCommitFiberUnmount() {}, onScheduleFiberRoot() {},
}
if (process.env.KYBERN_PACING_RUNNING_ENTRY === '1') await import('../scripts/native-perf-fixture.tsx')
else await import('../src/main.tsx')
// The production window can start hidden for an explicit automation frame.
// Restore before showing; ordering every window here would bypass main's guard.
const automatedDisplay = process.env.GPUIX_BACKGROUND === '1' && process.env.KYBERN_TEST_DISPLAY !== 'any'
if (automatedDisplay) {
  const {restoreWindowFrame} = await import('../src/shell/window.ts')
  const deadline = Date.now() + 10000
  while (!restoreWindowFrame()) {
    if (Date.now() >= deadline) throw Error('Automation frame could not be restored before showing')
    await Bun.sleep(25)
  }
}
// Keep only our own background fixture visible; never activate it.
const { each, getObjc, nsApp, sel } = await import('../src/native/objc.ts')
const o = getObjc(), app = nsApp()
if (app) each(o, o.msg(app, sel(o, 'windows')) as Pointer, window => {
  o.msgSetI64(window, sel(o, 'setLevel:'), 3n)
  if(process.env.KYBERN_PACING_IGNORE_PHYSICAL_MOUSE==='1')o.msgSetBool(window,sel(o,'setIgnoresMouseEvents:'),true)
  if (!automatedDisplay) o.msg(window, sel(o, 'orderFrontRegardless'))
})
export {}
