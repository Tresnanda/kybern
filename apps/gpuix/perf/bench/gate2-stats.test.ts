import {test,expect} from 'bun:test'
import {plan,bootstrap,verdict,sameCadence,shuffle,mulberry32,median} from './gate2-stats.ts'
test('plan: every arm once per round, even rounds reverse the previous round, same seed same plan',()=>{
 const arms=['window','sidebar','solid','solid-aa'],scenarios=['streaming','thread-scroll','sidebar-scroll','idle-home']
 const p=plan(arms,scenarios,4,7)
 expect(p).toHaveLength(16)
 for(let r=1;r<=4;r++)expect(p.filter(x=>x.round===r).map(x=>x.arm).sort()).toEqual([...arms].sort())
 const order=(r:number)=>p.filter(x=>x.round===r).map(x=>x.arm)
 expect(order(2)).toEqual([...order(1)].reverse());expect(order(4)).toEqual([...order(3)].reverse())
 expect(p.every(x=>[...x.scenarios].sort().join()===[...scenarios].sort().join())).toBe(true)
 expect(plan(arms,scenarios,4,7)).toEqual(p);expect(plan(arms,scenarios,4,8)).not.toEqual(p)
})
test('shuffle keeps the members; median handles even and empty input',()=>{
 expect(shuffle([1,2,3,4,5],mulberry32(1)).sort()).toEqual([1,2,3,4,5]);expect(median([])).toBeNull();expect(median([4,1,3,2])).toBe(2.5)
})
test('bootstrap: constant deltas give a point CI, spread deltas bracket the median, resampling is seeded',()=>{
 expect(bootstrap([2,2,2,2],1)).toMatchObject({est:2,lo:2,hi:2,n:4})
 const ci=bootstrap([1,2,3,10],1)!;expect(ci.lo).toBeLessThanOrEqual(ci.est);expect(ci.hi).toBeGreaterThanOrEqual(ci.est);expect(bootstrap([1,2,3,10],1)).toEqual(ci);expect(bootstrap([],1)).toBeNull()
})
test('cadence validity: >10% submission difference invalidates',()=>{expect(sameCadence(900,880)).toBe(true);expect(sameCadence(700,900)).toBe(false);expect(sameCadence(0,0)).toBe(true)})
test('verdict: fails only above threshold by CI lower bound; A/A reaching the threshold makes it uninformative',()=>{
 const ci=(est:number,lo:number,hi:number,n=4)=>({est,lo,hi,n})
 expect(verdict(ci(3,2,4),1.5,{hi:0.5})).toBe('FAIL')
 expect(verdict(ci(1,0,2),1.5,{hi:0.5})).toBe('unresolved')
 expect(verdict(ci(0.2,-0.5,0.9),1.5,{hi:0.5})).toBe('pass')
 expect(verdict(ci(3,2,4),1.5,{hi:2})).toBe('uninformative')
 expect(verdict(ci(3,2,4,2),1.5,{hi:0})).toBe('insufficient');expect(verdict(null,1,null)).toBe('insufficient')
})
