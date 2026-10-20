import {readState,connect} from '../visual/fixture.ts'
import {ids} from '../visual/fixture.conversation.ts'
import {writeFileSync} from 'node:fs'
const state=readState();if(!state||state.port===4219)throw Error('Audit proxy required')
const c=await connect(state);await ids(c);c.close()
writeFileSync('/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16/conversation-proxy-owner.json',JSON.stringify({pid:process.pid}))
console.log('Audit conversation proxy ready')
process.once('SIGTERM',()=>process.exit(0));await new Promise(()=>{})
