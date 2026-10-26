/**
 * WP5: system notifications on Linux and Windows, through the app's own module (`src/native/notifications.ts`) on the
 * addon's renderer, from `notify-lab.tsx`. macOS keeps its UserNotifications companion (`packaging/notification-check.ts`).
 *
 * Linux  A session bus with a test notification server (`notify-server.py`, python3-gi) stands in for the desktop's.
 *        The check asserts the `Notify` call's fields (app name, icon, desktop entry, summary, escaped body, the
 *        `default` action, sound), that a second post for the same thread carries `replaces_id`, that another
 *        thread does not, and that `ActionInvoked` reaches the module once per click with the id on screen. A second
 *        run without any server must report `unsupported` and post nothing. The check re-runs itself under
 *        `dbus-run-session` when no private bus is set up.
 * Windows The toast API runs with the installed AppUserModelID: the status resolves, the AppUserModelId registry
 *        entry exists, the posts return, and the toasts show in the action-center history (grouped per thread). A click
 *        needs a person at the shell, so it is checked by hand on a real PC (PORTING-PLATFORMS.md, WP5).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { launch, outputDir, platform, settled, step, type Fixture } from './check-harness.ts'

const here = import.meta.dir
const APP_ID = 'dev.kybern.gpuix'

if (platform === 'macos') {
  console.log('skip  macOS notifies through the UserNotifications companion (packaging/notification-check.ts)')
  process.exit(0)
}

const text = async (f: Fixture, id: string) => String(await f.app.getByTestId(id).textContent())
const waitText = (f: Fixture, id: string, done: (value: string) => boolean, timeoutMs = 8000) =>
  settled(() => text(f, id), done, timeoutMs)
async function clickPost(f: Fixture, id: string) {
  await f.app.getByTestId(id).click()
  await waitText(f, 'posted', value => value.includes(`${id}=`))
}

// ---- Linux ----

interface Call { op: string; id?: number; app_name?: string; replaces_id?: number; app_icon?: string; summary?: string; body?: string; actions?: string[]; hints?: Record<string, unknown>; line?: string }

async function linux() {
  if (!process.env.KYBERN_NOTIFY_BUS) {
    // A private session bus: the check must never talk to (or own a name on) the developer's real one.
    const result = spawnSync('dbus-run-session', ['--', process.execPath, ...process.argv.slice(1)], { env: { ...process.env, KYBERN_NOTIFY_BUS: '1' }, stdio: 'inherit' })
    process.exit(result.status ?? 1)
  }
  const dir = outputDir('notify')
  const log = path.join(dir, 'server.jsonl')
  const control = path.join(dir, 'control.txt')
  writeFileSync(log, '')
  writeFileSync(control, '')
  const calls = (): Call[] => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const notifies = () => calls().filter(call => call.op === 'Notify')
  const waitNotifies = async (count: number) => {
    const found = await settled(async () => notifies(), list => list.length >= count, 8000)
    assert.ok(found.length >= count, `expected ${count} Notify calls, saw ${found.length}: ${JSON.stringify(calls())}`)
    return found
  }
  const command = (line: string) => appendFileSync(control, line + '\n')

  // -- without a server: unsupported, nothing posted, nothing thrown
  let f = await launch(path.join(here, 'notify-lab.tsx'))
  try {
    await step('no daemon: status', async () => {
      await f.app.getByTestId('ready').waitFor()
      const status = await waitText(f, 'status', value => value !== 'pending')
      assert.equal(status, 'host:unsupported', 'without a notification daemon the backend must report unsupported')
      assert.match(await text(f, 'reason'), /No notification service/)
      await clickPost(f, 'post-t1-a')
      assert.equal(await text(f, 'posted'), 'post-t1-a=false', 'nothing is posted without a daemon')
    })
  } catch (error) { console.error(f.diagnostics()); throw error } finally { await f.close() }

  // -- with one
  const server: ChildProcess = spawn('python3', ['-I', path.join(here, 'notify-server.py'), '--log', log, '--control', control], { stdio: ['ignore', 'inherit', 'inherit'] })
  try {
    const ready = await settled(async () => calls().some(call => call.op === 'ready'), Boolean, 10000)
    assert.ok(ready, 'the test notification server did not come up (python3-gi missing?)')
    f = await launch(path.join(here, 'notify-lab.tsx'))
    await f.app.getByTestId('ready').waitFor()
    await step('status granted', async () => {
      assert.equal(await waitText(f, 'status', value => value !== 'pending'), 'host:granted')
      assert.equal(await text(f, 'reason'), '-')
    })
    await step('Notify fields', async () => {
      await clickPost(f, 'post-t1-a')
      const [first] = await waitNotifies(1)
      assert.equal(first!.app_name, 'Kybern')
      assert.equal(first!.app_icon, APP_ID)
      assert.equal(first!.summary, 'Fix login')
      assert.equal(first!.body, 'Needs approval: run &lt;tests&gt; &amp; lint', 'markup in an agent\'s text is escaped')
      assert.equal(first!.replaces_id, 0)
      assert.ok(first!.actions?.includes('default'), `no default action: ${JSON.stringify(first!.actions)}`)
      assert.equal(first!.hints?.['desktop-entry'], APP_ID)
      assert.equal(first!.hints?.['sound-name'], 'message-new-instant')
    })
    await step('replace per thread', async () => {
      await clickPost(f, 'post-t1-b')
      await clickPost(f, 'post-t2')
      const list = await waitNotifies(3)
      assert.equal(list[1]!.summary, 'Fix login')
      assert.equal(list[1]!.replaces_id, list[0]!.id, 'the same thread replaces its notification')
      assert.equal(list[1]!.id, list[0]!.id)
      assert.equal(list[2]!.summary, 'Parser audit')
      assert.equal(list[2]!.replaces_id, 0, 'another thread gets its own notification')
      assert.notEqual(list[2]!.id, list[0]!.id)
    })
    await step('click opens the thread', async () => {
      const [t1, , t2] = notifies()
      command(`invoke ${t1!.id} default`)
      const clicks = await waitText(f, 'clicks', value => value !== '-')
      // Both posts for the thread are waiting on the same server id; only the one on screen may report.
      assert.equal(clicks, 'agent:t1:2', 'a click reports the notification that replaced the first')
      command(`invoke ${t2!.id} default`)
      assert.equal(await waitText(f, 'clicks', value => value.split(' ').length >= 2), 'agent:t1:2 agent:t2:1')
      await Bun.sleep(500)
      assert.equal(await text(f, 'clicks'), 'agent:t1:2 agent:t2:1', 'one click, one report')
    })
    await step('after a click or a close the thread posts anew', async () => {
      // Both threads were clicked, and a server closes what it activated: the next post is new, then replaces it.
      await clickPost(f, 'post-t1-b')
      await clickPost(f, 'post-t1-a')
      const list = await waitNotifies(5)
      assert.equal(list[3]!.replaces_id, 0, 'after a click the thread starts a new notification')
      assert.equal(list[4]!.replaces_id, list[3]!.id)
      command(`close ${list[3]!.id} 2`)
      await Bun.sleep(300)
      await clickPost(f, 'post-t2')
      await clickPost(f, 'post-t1-b')
      const after = await waitNotifies(7)
      assert.equal(after[5]!.summary, 'Parser audit')
      assert.equal(after[6]!.replaces_id, 0, 'after the server closed it the thread starts a new notification')
    })
    console.log('ok  Linux: Notify fields, replace per thread, ActionInvoked once per click, unsupported without a daemon')
  } catch (error) { console.error(f.diagnostics()); console.error(readFileSync(log, 'utf8')); throw error } finally {
    await f.close()
    command('quit')
    server.kill()
  }
}

// ---- Windows ----

function powershell(script: string) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
  return { code: result.status, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() }
}

async function windows() {
  const f = await launch(path.join(here, 'notify-lab.tsx'), { RUST_LOG: 'warn' })
  try {
    await f.app.getByTestId('ready').waitFor()
    const status = await waitText(f, 'status', value => value !== 'pending')
    console.log(`Windows toast status: ${status} (${await text(f, 'reason')})`)
    if (status !== 'host:granted') console.log(`addon log: ${f.diagnostics()}`)
    await step('toast API with the AUMID', async () => {
      assert.match(status, /^host:(granted|denied)$/, 'the addon must reach the toast notifier with the AppUserModelID')
    })
    if (status !== 'host:granted') { console.log('toasts are not available to post on this account; posts are skipped'); return }
    await step('posts return', async () => {
      await clickPost(f, 'post-t1-a')
      await clickPost(f, 'post-t1-b')
      await clickPost(f, 'post-t2')
      assert.equal(await text(f, 'posted'), 'post-t1-a=true post-t1-b=true post-t2=true')
    })
    // GPUI registers the AUMID's display name on the first toast, so a run without the installer's shortcut still shows "Kybern".
    await step('AppUserModelId registration', async () => {
      const result = spawnSync('reg', ['query', `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`, '/v', 'DisplayName'], { encoding: 'utf8' })
      assert.equal(result.status, 0, `no AppUserModelId registry entry: ${result.stderr}`)
      assert.match(result.stdout, /DisplayName\s+REG_SZ\s+Kybern/)
    })
    // The action center keeps what the API accepted (readable on the windows-2022 runner too).
    await step('toasts in the history, one per thread', async () => {
      const history = await settled(async () => powershell(
        `[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]; ` +
        `@([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('${APP_ID}')).Count`), value => value.out === '2', 6000)
      assert.equal(history.out, '2', `history: ${history.out} ${history.err}`)
    })
    console.log('ok  Windows: toast API with the AUMID, registry entry, posts, history')
  } catch (error) { console.error(f.diagnostics()); throw error } finally { await f.close() }
}

await (platform === 'linux' ? linux() : windows())
