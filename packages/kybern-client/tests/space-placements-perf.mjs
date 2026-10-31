// Manual bounded workload: bun packages/kybern-client/tests/space-placements-perf.mjs
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mergeProjects } from "../src/machineMerge.ts";
import { logicalSpace, prepareSpacePlacements, setSpacePlacements, spaceProject } from "../src/spacePlacements.ts";
for (const count of [100,500,1000]) {
  const machines=new Map();const placements=[];
  for (let i=0;i<count;i++) {
    const machine=`m${i%10}`;
    const p={id:`p${i}`,name:`Project ${i}`,path:`/p/${i}`,repo:{root_commit:`root${i}`},kind:"single"};
    const list=machines.get(machine)??[];list.push(p);machines.set(machine,list);
    placements.push({project:spaceProject(machine,p),space_id:i%2?"work":"personal",lamport:1,signer:machine,op_id:String(i)});
  }
  const logicals=mergeProjects(machines);const times=[];
  for(let run=0;run<6;run++) {
    const start=performance.now();
    setSpacePlacements([{id:"work"},{id:"personal",is_default:true}],placements.map(p=>({...p,lamport:run+1})));
    prepareSpacePlacements(logicals);
    for(const logical of logicals) assert.equal(logicalSpace(logical),Number(logical.primary.project.id.slice(1))%2?"work":"personal");
    if(run)times.push(performance.now()-start);
  }
  times.sort((a,b)=>a-b);console.log(JSON.stringify({projects:count,machines:10,median_ms:+times[2].toFixed(2),max_ms:+times.at(-1).toFixed(2),includes:"replica invalidation, batch merge, all lookups, assertions",runtime:process.version,arch:process.arch}));
}
setSpacePlacements([]);
