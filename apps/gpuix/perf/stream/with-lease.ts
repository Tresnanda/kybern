import path from 'node:path'
import {lease} from '../bench/lease.ts'
import {onExit} from '../bench/lifetime.ts'
const args = process.argv.slice(2)
if (!args.length) throw Error('Pass a command to run under one UI lease')
const release = await lease()
const leave = onExit(release)
const child = Bun.spawn(args, {
  env: {...process.env, KYBERN_PACING_PARENT_LEASE: path.resolve(import.meta.dir, '../../../..')},
  stdout: 'inherit', stderr: 'inherit',
})
const stop = onExit(async () => { child.kill('SIGTERM'); await child.exited })
const timer = setTimeout(() => process.kill(process.pid, 'SIGTERM'), 270_000)
try { process.exitCode = await child.exited }
finally { clearTimeout(timer); stop(); release(); leave() }
