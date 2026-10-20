import assert from 'node:assert/strict'
import {openSync,closeSync,readFileSync} from 'node:fs'
const normal=Bun.spawn(['bun','scripts/dock7b-perf.ts'],{stdout:'inherit',stderr:'inherit'})
assert.equal(await normal.exited,0)
const output='/Users/mymac/projects/ade/previews/gpuix/round7/dock7b'
const pacing=['dark','light'].map(theme=>JSON.parse(readFileSync(`${output}/pacing-${theme}-normal.json`,'utf8')))
if(pacing.some(result=>result.p95>20)) {
  const wake=Bun.spawn(['bun','scripts/dock7b-perf.ts'],{env:{...process.env,KYBERN_VSYNC_WAKE:'1',DOCK7B_LABEL:'-vsync-wake'},stdout:'inherit',stderr:'inherit'})
  assert.equal(await wake.exited,0)
}
const file=openSync('/Users/mymac/projects/ade/previews/gpuix/round7/dock7b/profile.log','w')
try {
  const profile=Bun.spawn(['bun','scripts/dock7b-perf.ts'],{env:{...process.env,DOCK7B_PROFILE:'1',KYBERN_FIXTURE_DIAGNOSTICS:'1'},stdout:file,stderr:file})
  assert.equal(await profile.exited,0)
} finally {closeSync(file)}
