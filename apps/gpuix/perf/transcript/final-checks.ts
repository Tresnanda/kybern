import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
const out = '/Users/mymac/projects/ade/previews/gpuix/perf/transcript'
const buffer=Bun.spawn(['bun','perf/transcript/buffered.ts'],{env:process.env,stdout:'pipe',stderr:'pipe'})
const [bufferOut,bufferErr]=await Promise.all([new Response(buffer.stdout).text(),new Response(buffer.stderr).text()])
writeFileSync(`${out}/buffered.log`,bufferOut+bufferErr)
if(await buffer.exited)throw Error('Buffered timing failed: '+(bufferOut+bufferErr).slice(-2000))
if(existsSync('/tmp/kybern-gpuix-quiet.perf-transcript'))unlinkSync('/tmp/kybern-gpuix-quiet.perf-transcript')
console.log('PASS buffered timing; quiet reservation released')
for (const [name, command] of [
  ['typecheck', ['pnpm', 'exec', 'tsc', '--noEmit']],
  ['harness-typecheck', ['pnpm', 'exec', 'tsc', '-p', 'perf/transcript/tsconfig.json']],
  ['native-typecheck', ['pnpm', 'exec', 'tsc', '-p', 'native/tsconfig.json']],
  ['tests', ['bun', 'test', './src']],
  ['final-pixels', ['bun', 'perf/transcript/p1-visual.ts']],
] as const) {
  const child = Bun.spawn([...command], { env: {...process.env, KYBERN_TRANSCRIPT_WINDOW_BUFFER:'1',KYBERN_TRANSCRIPT_SLOT_CACHE:'1'}, stdout:'pipe', stderr:'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const code = await child.exited
  writeFileSync(`${out}/${name}.log`, stdout + stderr)
  if(code) throw Error(`${name} failed: ${(stdout + stderr).slice(-2000)}`)
  console.log(`PASS ${name}`)
}

for(const compact of ['0','1']){
 const child=Bun.spawn(['bun','perf/transcript/verify.ts'],{env:{...process.env,TRANSCRIPT_COMPACT:compact,KYBERN_TRANSCRIPT_WINDOW_BUFFER:'1',KYBERN_TRANSCRIPT_SLOT_CACHE:'1',KYBERN_TRANSCRIPT_LAYOUT:'1'},stdout:'pipe',stderr:'pipe'})
 const [stdout,stderr]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()])
 const code=await child.exited
 writeFileSync(`${out}/final-verify-${compact}.log`,stdout+stderr)
 if(code)throw Error('Transcript verification failed: '+(stdout+stderr).slice(-2000))
 console.log(`PASS transcript compact=${compact}`)
}
const counts=Bun.spawn(['bun','perf/transcript/counts.ts'],{env:process.env,stdout:'inherit',stderr:'inherit'})
if(await counts.exited)throw Error('Structural counts failed')
