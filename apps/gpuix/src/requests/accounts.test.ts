import {expect,test} from 'bun:test'
import {readAccounts} from './accounts.ts'

test('rail and composer share one pending account probe, then release its result',async()=>{
 let resolve!:(value:{accounts:[]})=>void,calls=0
 const client={call:()=>{calls++;return new Promise<{accounts:[]}>(done=>{resolve=done})}}
 const rail=readAccounts(client),composer=readAccounts(client)
 expect(composer).toBe(rail);expect(calls).toBe(1)
 resolve({accounts:[]});expect(await rail).toEqual({accounts:[]})
 const later=readAccounts(client);expect(later).not.toBe(rail);expect(calls).toBe(2)
 resolve({accounts:[]});await later
})

test('refresh and another environment do not reuse an ordinary read; rejection permits retry',async()=>{
 let calls=0,finish!:(value:{accounts:[]})=>void
 const client={call:(_method:'providers.accounts.list',params:{refresh?:boolean})=>{
  calls++;if(params.refresh)return Promise.resolve({accounts:[]})
  return new Promise<{accounts:[]}>(done=>{finish=done})
 }}
 const normal=readAccounts(client),refresh=readAccounts(client,true)
 expect(refresh).not.toBe(normal);expect(calls).toBe(2);await refresh
 const another={call:()=>Promise.resolve({accounts:[]})}
 expect(readAccounts(another)).not.toBe(normal)
 finish({accounts:[]});await normal
 // A failed transport must release the pending slot as well.
 let attempts=0
 const retry={call:()=>{attempts++;return attempts===1?Promise.reject(Error('offline')):Promise.resolve({accounts:[]})}}
 await expect(readAccounts(retry)).rejects.toThrow('offline')
 expect(await readAccounts(retry)).toEqual({accounts:[]});expect(attempts).toBe(2)
})
