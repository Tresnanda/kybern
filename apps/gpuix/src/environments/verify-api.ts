// Explicitly isolated integration fixture. Does not start an agent or touch the
// default daemon, client registry or system Keychain.
import { readFileSync, writeFileSync } from 'node:fs'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { pairingInvitation } from '../../../../packages/kybern-client/src/address.ts'
import { saveEnvironment, forgetEnvironment, verifyEndpoint } from './actions.ts'
import { readRegistry, profileEndpoint } from './registry.ts'
if (!process.env.KYBERN_CLIENT_CONFIG_DIR?.match(/ade-gpuix-scratch|apps\/gpuix\/\.combined/) || !process.env.KYBERN_GPUIX_CREDENTIALS_DIR?.match(/ade-gpuix-scratch|apps\/gpuix\/\.combined/)) throw Error('Use isolated scratch client paths')
const dir = process.env.KYBERN_VERIFY_SECOND_DATA ?? '/Users/mymac/projects/ade-gpuix-scratch/environments-second'
const endpoint = { url: `ws://127.0.0.1:${readFileSync(`${dir}/daemon.port`, 'utf8').trim()}/ws`, token: readFileSync(`${dir}/daemon.token`, 'utf8').trim() }
const client = new KybernClient(endpoint, { createSocket: (url, token) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${token}` } } as unknown as string[]) })
client.connect()
try {
  await new Promise<void>((resolve, reject) => { const stop = client.onStatus((status, detail) => { if (status === 'open') { stop(); resolve() } else if (status === 'failed') { stop(); reject(Error(detail)) } }) })
  // Save a separate scratch profile temporarily: the normal B profile is already
  // registered, so temporarily remove metadata only, keeping its test credential.
  const { writeRegistry } = await import('./registry.ts')
  const before = readRegistry()
  writeRegistry({ ...before, environments: before.environments.filter((p) => p.id !== 'scratch-second') })
  try {
    const tokens = await client.call('access.tokens.list', {})
    const invitation = await client.call('access.pairing.create', {})
    const profile = await saveEnvironment({ id: 'verification-pair', name: 'Pair test', address: pairingInvitation(endpoint.url, invitation.code, client.info!.environment_id) })
    if (profile.environment_id !== client.info!.environment_id) throw Error('Identity not retained')
    const edited = await saveEnvironment({ id: profile.id, name: 'Edited pair test', address: profile.url! })
    if (edited.name !== 'Edited pair test') throw Error('Edit not retained')
    await verifyEndpoint(await profileEndpoint(edited))
    const after = await client.call('access.tokens.list', {})
    const created = after.tokens.find((t) => !tokens.tokens.some((old) => old.id === t.id))
    if (!created) throw Error('Device not listed')
    await client.call('access.tokens.revoke', { token_id: created.id })
    let rejected = false
    try { await verifyEndpoint(await profileEndpoint(edited)) } catch { rejected = true }
    if (!rejected) throw Error('Revoked credential connected')
    await forgetEnvironment(profile.id)
    if (readRegistry().environments.some((p) => p.id === profile.id)) throw Error('Forget did not remove profile')
    console.log('Pairing redemption, identity verification, profile edit, device revoke and forget passed')
  } finally { writeRegistry(before) }
  const project = await client.call('projects.add', { path: process.env.KYBERN_VERIFY_PROJECT ?? '/Users/mymac/projects/ade-gpuix-scratch/environment-project', name: 'Cleanup fixture' })
  const thread = await client.call('threads.create', { project_id: project.id, provider: { kind: 'claude-code', instance: 'default' }, model: 'claude-haiku-5-5', title: 'Environment cleanup verification', use_worktree: true })
  const inspection = await client.call('threads.worktree.inspect', { thread_id: thread.id })
  if (!inspection.exists || !inspection.clean || inspection.blockers.length) throw Error('Scratch worktree is not eligible')
  writeFileSync(`${process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/gpuix/environments'}/worktree-fixture.json`, JSON.stringify({ threadId: thread.id, projectId: project.id, path: inspection.path }))
  console.log('Worktree cleanup fixture ready', thread.id)
} finally { client.close() }
