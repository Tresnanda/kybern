import path from 'node:path'
import {pacingLock} from './pacing-lock.ts'
export type PacingJob={args:string[];env?:Record<string,string>}
/** Group short fixtures in a lease, handing it back before the five-minute cap. */
export async function runPacingJobs(jobs:PacingJob[]){
 const failures:unknown[]=[]
 for(let i=0;i<jobs.length;){
  const release=await pacingLock(),start=performance.now()
  try{do{
   const {args,env}=jobs[i++]!;console.log('START',JSON.stringify(args))
   const child=Bun.spawn(['bun',...args],{env:{...process.env,...env,KYBERN_PACING_PARENT_LEASE:path.resolve(import.meta.dir,'../../..')},stdout:'inherit',stderr:'inherit'})
   const code=await child.exited;if(code){failures.push({args,code});console.error('FAILED',JSON.stringify(args),code)}
  }while(i<jobs.length&&performance.now()-start<120000)}finally{release()}
 }
 console.log('FAILURES',JSON.stringify(failures));process.exitCode=failures.length?1:0
}
