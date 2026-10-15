import {Database} from 'bun:sqlite'
import path from 'node:path'
const data=process.env.KYBERN_DATA_DIR!,thread=process.env.KYBERN_GPUIX_THREAD!
if(!data?.includes('gpuix-scratch')||!thread)throw Error('Isolated fixture required')
const db=new Database(path.join(data,'state.sqlite'))
process.env.KYBERN_AUDIT_PROJECT=(db.query('SELECT project_id FROM threads WHERE id=?').get(thread) as {project_id:string}).project_id
try {const result=db.query("UPDATE threads SET coordinator_project_id=project_id WHERE id=? AND project_id IS NOT NULL").run(thread);if(result.changes!==1)throw Error('Missing fixture thread')}finally{db.close()}
const child=Bun.spawn(['bun','scripts/audit-project-check.ts','--write'],{env:process.env,stdout:'inherit',stderr:'inherit'});process.exitCode=await child.exited
