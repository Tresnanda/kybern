// Preserve the existing fixture's stdio automation for an already built bundle.
import {spawn} from 'node:child_process'
const executable=process.env.KYBERN_BENCH_PACKAGED_EXECUTABLE
if(!executable)throw Error('Missing packaged executable')
const child=spawn(executable,[],{env:process.env,stdio:'inherit'})
process.once('SIGTERM',()=>child.kill());process.once('SIGINT',()=>child.kill())
child.once('exit',code=>process.exit(code??1))
