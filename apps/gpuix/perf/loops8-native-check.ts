import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { pacingLock } from './loops8-lock.ts'
import {waitForNativeBuilds} from './loops8-build-free.ts'
const check=process.argv[2]??'frame'
const files:Record<string,string>={frame:'native/frame-check.ts',region:'native/paint-region-check.ts',paint:'native/paint-check.ts',island:'scripts/island-check.ts',overlay:'scripts/island-overlay-check.ts',capability:'native/capability-check.ts',layout:'native/layout-check.ts',markdown:'native/markdown-check.ts',diff:'native/diff-check.ts',motion:'scripts/native-motion-check.ts',syntax:'native/syntax-lifecycle-check.ts',native:'scripts/native-check.ts'}
if(!files[check]&&!['text','region-light-reduced','desktop-loops'].includes(check))throw Error(`Unknown check ${process.env.KYBERN_LOOPS_OUTPUT_TAG??check}`)
const out=`/Users/mymac/projects/ade/previews/gpuix/round8/loops/${process.env.KYBERN_LOOPS_OUTPUT_TAG??check}`
mkdirSync(out,{recursive:true})
await waitForNativeBuilds()
const release=await pacingLock()
try {
  const child=Bun.spawn([check==='desktop-loops'?'node':'bun',check==='text'?'native/paint-text-check.ts':check==='region-light-reduced'?'native/paint-region-check.ts':check==='desktop-loops'?'perf/loops8-webkit.mjs':files[check]!],{cwd:path.resolve(import.meta.dir,'..'),env:{...process.env,GPUIX_BACKGROUND:'1',NAPI_RS_NATIVE_LIBRARY_PATH:process.env.KYBERN_PACING_ADDON??path.join(import.meta.dir,'../native/build/gpuix-native.darwin-arm64.node'),KYBERN_NATIVE_PAINT_ANIMATIONS:'1',KYBERN_FULL_RATE:'1',KYBERN_VSYNC_WAKE:'1',KYBERN_REGION_PAINT:'1',KYBERN_DEBUG_REGION:'1',...(check==='region'?{KYBERN_GPU_TRACE:'1',KYBERN_REGION_EXPECT_DISJOINT:'1'}:{}),KYBERN_VERIFY_OUTPUT:check==='region-light-reduced'?out.replace('region-light-reduced','region'):out,...(check==='region-light-reduced'?{KYBERN_CHECK_THEMES:'light',KYBERN_CHECK_REDUCED:'1'}:{})},stdout:'inherit',stderr:'inherit'})
  process.exitCode=await child.exited
} finally {release()}
