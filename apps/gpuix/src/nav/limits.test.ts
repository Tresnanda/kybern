import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

test('cached usage polls preserve store identities, while changed values and freshness still publish', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'kybern-limits-pacing-'))
  try {
    const child = Bun.spawnSync(['bun', '-e', `
      const {getNav,subscribeNav}=await import(${JSON.stringify(new URL('./store.ts', import.meta.url).pathname)});
      const {applyUsageLimits}=await import(${JSON.stringify(new URL('./limits.ts', import.meta.url).pathname)});
      const {strict:assert}=await import('node:assert');let notifications=0;
      const stop=subscribeNav(()=>notifications++),empty=getNav().limits;
      applyUsageLimits({providers:[]});assert.equal(notifications,0);assert.equal(getNav().limits,empty);
      const payload={providers:[{provider:'codex',limits:[{name:'session',used_percent:20,window_minutes:300,resets_at:null}],updated_at:'2026-10-18T00:00:00Z'}]};
      applyUsageLimits(payload);assert.equal(notifications,1);const limits=getNav().limits;
      applyUsageLimits(JSON.parse(JSON.stringify(payload)));assert.equal(notifications,1);assert.equal(getNav().limits,limits);
      let changed=JSON.parse(JSON.stringify(payload));changed.providers[0].limits[0].used_percent=21;
      applyUsageLimits(changed);assert.equal(notifications,2);assert.equal(getNav().limits[0].limits[0].used_percent,21);
      changed=JSON.parse(JSON.stringify(changed));changed.providers[0]={...changed.providers[0],updated_at:'2026-10-18T00:01:00Z'};
      applyUsageLimits(JSON.parse(JSON.stringify(changed)));assert.equal(notifications,3);
      applyUsageLimits({...changed,refreshing:['codex']});assert.equal(notifications,4);const refreshing=getNav().limitsRefreshing;
      applyUsageLimits(JSON.parse(JSON.stringify({...changed,refreshing:['codex']})));assert.equal(notifications,4);assert.equal(getNav().limitsRefreshing,refreshing);
      applyUsageLimits(changed);assert.equal(notifications,5);assert.deepEqual(getNav().limitsRefreshing,[]);stop();
    `], {env:{...process.env,KYBERN_DATA_DIR:scratch,KYBERN_CLIENT_CONFIG_DIR:path.join(scratch,'client'),KYBERN_URL:'',KYBERN_TOKEN:''},stdout:'pipe',stderr:'pipe'})
    expect(child.exitCode, child.stderr.toString()).toBe(0)
  } finally { rmSync(scratch,{recursive:true,force:true}) }
})
