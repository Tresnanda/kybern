import path from 'node:path'
import { readFileSync, writeFileSync, watch } from 'node:fs'
const root = path.resolve(import.meta.dir, '../../../..')
Bun.plugin({ name: 'hr5-hover-audit', setup(build) {
  build.onLoad({ filter: /\/src\/(App|ui|sidebar\/rows)\.tsx$/ }, args => {
    const relative = path.relative(root, args.path)
    let source = process.env.HR5_SOURCE === 'before'
      ? Bun.spawnSync(['git', 'show', `e1ffabf6:${relative}`], { cwd: root }).stdout.toString()
      : readFileSync(args.path, 'utf8')
    return { contents: source, loader: 'tsx' }
  })
} })
let auditRoot: {containerInfo?:{nativeRenderer?:{richEditorCommand(id:number,command:unknown):unknown;getListScrollTop(id:number):number[]|null;getScrollOffset(id:number):number[]|null}}}|undefined
;(globalThis as Record<string,unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,renderers:new Map(),inject(){return 1},onCommitFiberRoot(_id:number,root:typeof auditRoot){auditRoot=root},onCommitFiberUnmount(){},onScheduleFiberRoot(){}}
await import('../../src/main.tsx')

if(process.env.HR5_INPUT){
 const {dlopen,FFIType}=await import('bun:ffi')
 const native=dlopen(path.join(process.env.VISUAL_SCRATCH!,'hover-input.dylib'),{hr5_prepare:{args:[],returns:FFIType.i32},hr5_click:{args:[FFIType.f64,FFIType.f64,FFIType.i32],returns:FFIType.i32},hr5_resize:{args:[FFIType.f64,FFIType.f64,FFIType.f64,FFIType.f64],returns:FFIType.i32}})
 let last=''
 watch(process.env.HR5_INPUT,()=>{
  try{const {x,y,count,nonce,editor,resize,scroll,prepare}=JSON.parse(readFileSync(process.env.HR5_INPUT!,'utf8'));if(!nonce||nonce===last)return;last=nonce;if(scroll!==undefined){const renderer=auditRoot?.containerInfo?.nativeRenderer;const offset=renderer?.getListScrollTop(scroll)??renderer?.getScrollOffset(scroll);writeFileSync(process.env.HR5_INPUT!+'.done',JSON.stringify({nonce,offset}));return}if(editor){const selection=auditRoot?.containerInfo?.nativeRenderer?.richEditorCommand(editor,{cmd:'getSelection'});writeFileSync(process.env.HR5_INPUT!+'.done',JSON.stringify({nonce,selection}));return}const accepted=prepare?native.symbols.hr5_prepare():resize?native.symbols.hr5_resize(resize[0],resize[1],resize[2],resize[3]):native.symbols.hr5_click(x,y,count);writeFileSync(process.env.HR5_INPUT!+'.done',JSON.stringify({nonce,accepted}))}catch{}
 })
}
