import '../cadence/control.ts'
import { readFileSync } from 'node:fs'
import { dlopen, FFIType as T } from 'bun:ffi'
import path from 'node:path'
if (process.env.SIDEBAR_SOURCE === 'baseline' || process.env.SIDEBAR_SOURCE === 'p1') Bun.plugin({ name: 'sidebar-baseline', setup(build) {
  build.onLoad({ filter: /\/src\/(?:Sidebar|sidebar\/(?:rows|reorder))\.tsx$/ }, args => {
    const root = path.resolve(import.meta.dir, '../../../..')
    const source = Bun.spawnSync(['git', 'show', `564151aa:${path.relative(root, args.path)}`], { cwd: root })
    if (source.exitCode) throw Error(source.stderr.toString())
    let contents = source.stdout.toString()
    if (process.env.SIDEBAR_SOURCE === 'p1') contents = contents.replace('<virtual-list ref=', '<virtual-list {...{ cacheLayout: true, cache: \'fill\' }} ref=')
    return { contents: contents.replace('<div ref={setBoxNode}', '<div testId="sidebar-viewport" ref={setBoxNode}'), loader: 'tsx' }
  })
} })
;(globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true, renderers: new Map(), inject() { return 1 },
  onCommitFiberRoot() { console.error('[sidebar-commit]') }, onCommitFiberUnmount() {}, onScheduleFiberRoot() {},
}
await import('../../src/main.tsx')
if (process.env.SIDEBAR_SCENE === 'running' || process.env.SIDEBAR_SCENE === 'mixed') {
  const { getState, set, subscribe } = await import('../../src/state.ts')
  const { setNav } = await import('../../src/nav/store.ts')
  const install = () => {
    const state = getState()
    if (!state.listsLoaded) return false
    const parents = state.projects.flatMap(project => state.threads.filter(thread => thread.project_id === project.id).slice(0, 1))
    const running = new Set(parents.map(thread => thread.id))
    const children = Object.fromEntries(parents.flatMap(parent => Array.from({ length: 2 }, (_, index) => {
      const id = `${parent.id}-child-${index}`
      return [id, { ...parent, id, pinned: false, parent_thread_id: parent.id, title: `Review implementation and verify ${index ? 'test coverage and renderer behaviour' : 'the sidebar geometry and disclosure motion'}`, status: 'running' as const,
        subagent: { task_id: id, root_thread_id: parent.id, parent_turn_id: 'fixture-turn', status: 'running' as const, started_at: parent.created_at } }] as const
    })))
    set({ threads: state.threads.map(thread => running.has(thread.id) ? { ...thread, status: 'running' } : thread), ...(process.env.SIDEBAR_SCENE === 'mixed' ? { collapsed: Object.fromEntries(state.projects.filter((_, index) => index % 3 === 2).map(project => [project.id, true])) } : {}) })
    setNav({ children, activity: Object.fromEntries(parents.map(thread => [thread.id, 'working' as const])) })
    console.error('[sidebar-fixture-ready]')
    return true
  }
  if (!install()) { const stop = subscribe(() => { if (getState().listsLoaded) { stop(); install() } }) }
}
const native = dlopen(new URL('../explorer/wheel.dylib', import.meta.url).pathname, {
  explorerFloat: { args: [], returns: T.void },
  explorerStartWheel: { args: [T.f64, T.f64, T.i32, T.f64, T.i32, T.cstring], returns: T.void },
}).symbols
native.explorerFloat()
process.on('SIGUSR1', () => {
  const plan = JSON.parse(readFileSync(process.env.SIDEBAR_PLAN!, 'utf8')) as { x: number; y: number; count: number; magnitude: number; horizontal?: boolean }
  native.explorerStartWheel(plan.x, plan.y, plan.count, plan.magnitude, plan.horizontal ? 1 : 0, Buffer.from(process.env.SIDEBAR_PLAN! + '.done\0'))
})
export {}
