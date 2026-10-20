import '../cadence/control.ts'
import { readFileSync } from 'node:fs'
import { dlopen, FFIType as T } from 'bun:ffi'
import path from 'node:path'
if (process.env.EXPLORER_BASELINE === '1') Bun.plugin({ name: 'explorer-baseline', setup(build) {
  build.onLoad({ filter: /\/src\/dock\/(Explorer|MotionFileTree)\.tsx$/ }, args => {
    const root = path.resolve(import.meta.dir, '../../../..')
    const source = Bun.spawnSync(['git', 'show', `${process.env.EXPLORER_BASE_REF ?? 'ef2251e2'}:${path.relative(root, args.path)}`], { cwd: root })
    if (source.exitCode) throw Error(source.stderr.toString())
    return { contents: source.stdout.toString(), loader: 'tsx' }
  })
} })
;(globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true, renderers: new Map(), inject() { return 1 },
  onCommitFiberRoot() { console.error('[explorer-commit]') }, onCommitFiberUnmount() {}, onScheduleFiberRoot() {},
}
if (process.env.EXPLORER_LIFECYCLE === '1') {
  await import('../../src/native/local-build.ts')
  const { GpuixRenderer } = await import('@gpuix/native')
  const prototype = GpuixRenderer.prototype as unknown as Record<string, (...args: unknown[]) => unknown>
  for (const method of ['createSyntaxDocument', 'releaseSyntaxDocument']) {
    const original = prototype[method]!
    prototype[method] = function (...args) {
      const result = original.apply(this, args)
      void Promise.resolve(result).then(() => {
        try { console.error('[explorer-syntax]', method, JSON.stringify(this.getSyntaxDocumentStats!())) } catch {}
      })
      return result
    }
  }
}
await import('../../src/main.tsx')
const native = dlopen(new URL('./wheel.dylib', import.meta.url).pathname, {
  explorerFloat: { args: [], returns: T.void },
  explorerStartWheel: { args: [T.f64, T.f64, T.i32, T.f64, T.i32, T.cstring], returns: T.void },
}).symbols
native.explorerFloat()
process.on('SIGUSR1', () => {
  const plan = JSON.parse(readFileSync(process.env.EXPLORER_PLAN!, 'utf8')) as { x: number; y: number; count: number; magnitude: number; horizontal?: boolean }
  native.explorerStartWheel(plan.x, plan.y, plan.count, plan.magnitude, plan.horizontal ? 1 : 0, Buffer.from(process.env.EXPLORER_PLAN! + '.done\0'))
})
export {}
