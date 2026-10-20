// Optional React commit diagnostics; keep profiling separate from timing runs.
if (process.env.R7_REACT === '1') {
  let commits = 0
  const counts: Record<string, number> = {}
  ;(globalThis as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    inject: () => 1,
    onCommitFiberRoot(_id: number, root: any) {
      const visit = (fiber: any) => {
        if (!fiber) return
        if (fiber.memoizedProps !== fiber.alternate?.memoizedProps || fiber.memoizedState !== fiber.alternate?.memoizedState) {
          const name = fiber.type?.displayName ?? fiber.type?.name ?? fiber.type?.render?.name
          if (name) counts[name] = (counts[name] ?? 0) + 1
        }
        visit(fiber.child); visit(fiber.sibling)
      }
      visit(root.current)
      console.error('[react-commits]', JSON.stringify({time:performance.now(),commits:++commits,counts}))
    },
    onCommitFiberUnmount() {},
  }
}
await import('./round7-app.ts')
// The automation window ignores physical mouse input from the user's ongoing work.
const { each, getObjc, nsApp, sel } = await import('../native/objc.ts')
const o = getObjc(), app = nsApp()
if (app) each(o, o.msg(app, sel(o, 'windows')) as any, window => {
  o.msgSetBool(window, sel(o, 'setIgnoresMouseEvents:'), true)
  o.msgSetBool(window, sel(o, 'setAcceptsMouseMovedEvents:'), false)
})
export {}
