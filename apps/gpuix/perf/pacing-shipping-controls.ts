import {runPacingJobs,type PacingJob} from './pacing-group.ts'
process.env.KYBERN_PACING_ADDON=new URL('../native/build/gpuix-native.darwin-arm64.node',import.meta.url).pathname
const jobs:PacingJob[]=[
 ...['home','settled-thread','tasks','thread'].map(scene=>({args:['perf/pacing-fixture.ts','--','bun','perf/pacing-resources.ts','shipping',scene],env:{KYBERN_PACING_DEFAULTS:'1'}})),
 ...['region','frame','text'].map(check=>({args:['perf/pacing-native-check.ts',check]})),
]
await runPacingJobs(jobs)
