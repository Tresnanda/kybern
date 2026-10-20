// Test-only instrumentation: native input is unchanged and snapshots never paint.
import { readFileSync, writeFileSync, renameSync, watch } from 'node:fs'
import path from 'node:path'
const trace: unknown[] = []
;(globalThis as any).__sidebarTrace = (event: unknown) => trace.push({at: performance.now(), ...event as object})
Bun.plugin({name: 'sidebar-hover-probe', setup(build) {
  build.onLoad({filter: /\/src\/sidebar\/(rows|reorder)\.tsx$/}, args => {
    let source = readFileSync(args.path, 'utf8')
    if (args.path.endsWith('/rows.tsx')) {
      source = source.replace('function useHover() {', 'function useHover(scope?: string) {')
        .replace('onMouseEnter: () => setHover(true),', 'onMouseEnter: (e?: any) => { (globalThis as any).__sidebarTrace({kind:"hover",scope,on:true,event:e}); setHover(true) },')
        .replace('onMouseLeave: () => setHover(false),', 'onMouseLeave: (e?: any) => { (globalThis as any).__sidebarTrace({kind:"hover",scope,on:false,event:e}); setHover(false) },')
      const start = source.indexOf('export const ProjectHeader')
      source = source.slice(0,start) + source.slice(start).replace('useHover()', 'useHover(project.id)')
      if (process.env.SIDEBAR_PRE_GUARD === '1') source = source.replace('if (!leftSource(e, renderer)) return; ', '')
    } else source = source.replace('function activate(start: Pending, x: number, y: number) {', 'function activate(start: Pending, x: number, y: number) { (globalThis as any).__sidebarTrace({kind:"drag",id:start.id,x,y,startX:start.x,startY:start.y});')
    return {contents:source,loader:'tsx'}
  })
}})
let root: any
;(globalThis as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {supportsFiber:true,inject:()=>1,onCommitFiberRoot(_id:number,value:any){root=value},onCommitFiberUnmount(){},onScheduleFiberRoot(){}}
await import('../../src/main.tsx')
const {getState,toggleProject,selectDraft} = await import('../../src/state.ts')
const {getNav} = await import('../../src/nav/store.ts')
const {dlopen,FFIType} = await import('bun:ffi')
const native = dlopen(path.join(process.env.VISUAL_SCRATCH!,'hover-input.dylib'), {hr5_prepare:{args:[],returns:FFIType.i32}})
let last = ''
watch(process.env.SIDEBAR_INPUT!, () => {
  try {
    const {nonce,prepare,clear,collapse,draft} = JSON.parse(readFileSync(process.env.SIDEBAR_INPUT!,'utf8'))
    if (!nonce || nonce===last) return
    last=nonce
    if(collapse) toggleProject(collapse)
    if(draft) selectDraft(draft)
    const rows: unknown[] = []
    const visit = (fiber:any) => {
      if (!fiber) return
      const name = fiber.type?.name ?? fiber.type?.type?.name
      if (['ProjectHeader','ThreadRow','CreateCoordinatorRow'].includes(name)) {
        const hooks:unknown[]=[]; let hook=fiber.memoizedState
        while(hook){hooks.push(hook.memoizedState);hook=hook.next}
        rows.push({name,id:fiber.memoizedProps?.project?.id ?? fiber.memoizedProps?.thread?.id,hooks:hooks.filter(h=>typeof h==='boolean')})
      }
      visit(fiber.child);visit(fiber.sibling)
    }
    visit(root?.current)
    writeFileSync(process.env.SIDEBAR_INPUT!+'.done.tmp', JSON.stringify({nonce,accepted:prepare?native.symbols.hr5_prepare():undefined,rows,trace,draft:getState().draft,selected:getState().selectedId,collapsed:getState().collapsed,order:getNav().projectOrder}));renameSync(process.env.SIDEBAR_INPUT!+'.done.tmp',process.env.SIDEBAR_INPUT!+'.done')
    if(clear) trace.length=0
  } catch(error) {console.error(error)}
})
