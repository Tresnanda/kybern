import {lease} from '../bench/lease.ts'
const release=await lease()
console.log('acquired')
if(process.env.CADENCE_LEASE_CRASH==='1')throw Error('Intentional lease crash test')
await Bun.sleep(60000)
release()
