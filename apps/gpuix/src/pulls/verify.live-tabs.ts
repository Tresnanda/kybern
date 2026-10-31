/** ADE-96 read-only integration against a real scratch daemon and this checkout's GitHub repository. */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'
const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-scratch-ade96-live-'))
const root = path.resolve(import.meta.dir, '../../../..')
const binary = process.env.KYBERND ?? path.join(root, 'target/debug/kybernd')
if (!existsSync(binary)) throw Error(`Build this checkout's daemon first: ${binary}`)
process.env.VISUAL_SCRATCH = scratch
process.env.KYBERND = binary
const tailnet = path.join(scratch, 'tailnet.json')
writeFileSync(tailnet, JSON.stringify({ self: 'ade96', nodes: [{ name:'ade96',node_id:'ade96-scratch',ip:'100.64.99.200',listen:'127.0.0.1',login:'ade96@example.invalid' }] }))
process.env.KYBERN_TAILSCALE_FAKE = tailnet
const fixture = await import('../../visual/fixture.ts')
let state: Awaited<ReturnType<typeof fixture.startDaemon>> | undefined
let client: Awaited<ReturnType<typeof fixture.connect>> | undefined
let window: Awaited<ReturnType<typeof launchFixture>> | undefined
try {
  state = await fixture.startDaemon(true)
  client = await fixture.connect(state)
  const project = await client.call('projects.add', { path:root, name:'ADE-96 live scratch' })
  const pulls = await client.call('github.pr.list', { project_id:project.id, state:'all',limit:5 })
  const pr = pulls.pull_requests[0]
  assert.ok(pr, 'the registered repository has a pull request to review')
  const thread = await client.call('threads.create', { project_id:project.id,provider:{kind:'codex',instance:'default'},permission_mode:'supervised',use_worktree:false,title:'ADE-96 scratch PR check' })
  const key = `pr:${project.id}:${pr.number}`
  writeFileSync(path.join(fixture.DATA_DIR,'gpuix-ui.json'), JSON.stringify({ 'kybern.split-view.v2': {version:2,root:{kind:'leaf',id:'main',threadId:thread.id},focusedPaneId:'main',groups:{main:{threadId:thread.id,tabs:[{kind:'chat'},{kind:'pr',projectId:project.id,number:pr.number,title:pr.title}],active:key,preview:null}}} }))
  window = await launchFixture(path.join(import.meta.dir,'../main.tsx'), {
    KYBERN_DATA_DIR:fixture.DATA_DIR,KYBERN_CLIENT_CONFIG_DIR:fixture.CLIENT_DIR,KYBERN_GPUIX_CREDENTIALS_DIR:fixture.CREDS_DIR,
    KYBERN_URL:`ws://127.0.0.1:${state.port}/ws`,KYBERN_TOKEN:state.token,GPUIX_BACKGROUND:'1',KYBERN_OPAQUE:'1',KYBERN_WINDOW_SIZE:'1440x900',
  })
  const a = window.app
  await a.getByTestId('pr-summary').waitFor({timeoutMs:30000})
  await a.getByTestId('pr-tab-changes').click();await a.getByTestId('pr-files').waitFor({timeoutMs:30000})
  await a.getByTestId('pr-tab-timeline').click();await a.getByTestId('pr-timeline-entries').waitFor({timeoutMs:30000})
  await a.getByTestId('tab-chat').click();await a.getByTestId(`tab-${key}`).click()
  await a.getByTestId('pr-timeline-entries').waitFor({timeoutMs:30000})
  assert.doesNotMatch(window.diagnostics(),/\[error-boundary\]/)
  if(process.env.KYBERN_VERIFY_OUTPUT){mkdirSync(process.env.KYBERN_VERIFY_OUTPUT,{recursive:true});await a.screenshot({path:path.join(process.env.KYBERN_VERIFY_OUTPUT,'live-scratch.png')})}
  console.log(`PASS real scratch daemon: ${pr.url}, Summary/Changes/Timeline and horizontal tab return; no GitHub writes`)
} finally {
  await window?.close()
  client?.close()
  if(state){fixture.stopPid(state.daemonPid);await Bun.sleep(300);try{process.kill(state.daemonPid,'SIGKILL')}catch{}}
  rmSync(scratch,{recursive:true,force:true})
}
process.exit(0)
