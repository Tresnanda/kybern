// Mock HTTP/WebSocket boundary, isolated registry and credentials. No SSH, daemon, or Keychain.
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { PROTOCOL_VERSION } from '../../../../packages/kybern-client/src/types.ts'
const root = mkdtempSync('/Users/mymac/projects/ade-gpuix-scratch/composer-profile-')
process.env.KYBERN_CLIENT_CONFIG_DIR = path.join(root,'client')
process.env.KYBERN_GPUIX_CREDENTIALS_DIR = path.join(root,'credentials')
process.env.KYBERN_DATA_DIR = path.join(root,'data')
const { saveEnvironment, forgetEnvironment } = await import('./actions.ts')
const { readRegistry } = await import('./registry.ts')
let identity = 'fixture-A', reportedIdentity = 'fixture-A'
const server = Bun.serve({ hostname:'127.0.0.1',port:0,
  fetch(request, server) {
    if (new URL(request.url).pathname === '/pair') return Response.json({token:'fixture-device-token',environment_id:identity})
    if (server.upgrade(request)) return
    return new Response('Not found',{status:404})
  },
  websocket: { message(ws, raw) {
    const req = JSON.parse(String(raw))
    ws.send(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{protocol_version:PROTOCOL_VERSION,environment_id:reportedIdentity,hostname:'scratch',version:'0.9.1',scopes:['access_write']}}))
  } },
})
const address = `ws://127.0.0.1:${server.port}/ws`
const ssh = {target:'fixture-host',port:2222,remote_port:4173,local_port:server.port!}
const assert = (value: unknown, message: string) => { if (!value) throw Error(message) }
try {
  const profile = await saveEnvironment({id:'fixture-A',name:'SSH fixture',address,code:'123456',expectedIdentity:identity,ssh})
  assert(profile.environment_id === identity && profile.ssh?.target === ssh.target,'Identity/SSH metadata was not saved')
  assert(readFileSync(path.join(root,'credentials/fixture-A.token'),'utf8') === 'fixture-device-token','Credential was not saved in isolated store')
  assert(!readFileSync(path.join(root,'client/environments.json'),'utf8').includes('fixture-device-token'),'Credential leaked into profile metadata')
  const edited = await saveEnvironment({id:profile.id,name:'Renamed fixture',address})
  assert(edited.ssh?.port === 2222,'Editing an environment lost SSH metadata')
  await forgetEnvironment(profile.id)
  assert(!readRegistry().environments.length && !existsSync(path.join(root,'credentials/fixture-A.token')),'Forget did not remove isolated profile and credential')
  identity = 'fixture-B'; reportedIdentity = 'wrong-fixture'
  let failed = false
  try { await saveEnvironment({id:'fixture-B',name:'Recovery fixture',address,code:'654321',expectedIdentity:identity,ssh}) } catch (error) { failed = String(error).includes('Paired and saved') }
  assert(failed,'Identity mismatch was not rejected')
  assert(existsSync(path.join(root,'credentials/fixture-B.token')) && readRegistry().environments.some(p => p.id === 'fixture-B'),'Redeemed pairing credentials were lost after failed handshake')
  console.log('PASS isolated pairing, SSH profile persistence/edit/forget, identity mismatch, and credential recovery')
} finally { await server.stop(true); rmSync(root,{recursive:true,force:true}) }
