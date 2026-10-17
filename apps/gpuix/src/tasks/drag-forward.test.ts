import {expect,test} from 'bun:test'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
test('task drag keeps processing events delivered to its pressed source after pickup',async()=>{
 const scratch=mkdtempSync(`${tmpdir()}/gpuix-scratch-task-drag-`)
 try{
  const child=Bun.spawn(['bun',`${import.meta.dir}/verify.drag-forward.ts`],{env:{...process.env,KYBERN_APPEARANCE:'dark',KYBERN_REDUCED_MOTION:'1',KYBERN_DATA_DIR:scratch,KYBERN_CLIENT_CONFIG_DIR:scratch,KYBERN_GPUIX_CREDENTIALS_DIR:scratch,KYBERN_URL:'ws://127.0.0.1:1/ws',KYBERN_TOKEN:'fixture'},stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  expect({code,err}).toEqual({code:0,err:''})
  expect(out).toContain('PASS sustained source-bound drag forwarding')
 }finally{rmSync(scratch,{recursive:true,force:true})}
})
