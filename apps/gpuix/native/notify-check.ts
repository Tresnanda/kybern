/**
 * WP5: system notifications on Linux and Windows, through the app's own module (`src/native/notifications.ts`) on the
 * addon's renderer, from `notify-lab.tsx`. macOS keeps its UserNotifications companion (`packaging/notification-check.ts`).
 *
 * Linux  A session bus with a test notification server (`notify-server.py`, python3-gi) stands in for the desktop's.
 *        The check asserts the `Notify` call's fields (app name, icon, desktop entry, summary, escaped body, the
 *        `default` action, sound), that a second post for the same thread carries `replaces_id` and no sound, that
 *        another thread does not, that two posts back to back are one notification, that `ActionInvoked` reaches the
 *        module once per click with the id on screen, that a dismissal closes the server's notification, and that a
 *        restarted server (ids from 1 again) is never sent a stale `replaces_id`. A server without `body-markup`
 *        gets the body unescaped. A first run without any server must report `unsupported` and post nothing. The
 *        check re-runs itself under `dbus-run-session` when no private bus is set up.
 * Windows The toast API runs with the AppUserModelID of a loose run (`dev.kybern.gpuix.dev`: the installed app's
 *        id is not touched): the status resolves, the AppUserModelId registry entry exists, the posts return, the
 *        toasts show in the action-center history (one per thread), a dismissal removes the thread's toast, and a
 *        post after the action center was cleared (what a user's dismissal leaves) shows again. A click needs a
 *        person at the shell, so it is checked by hand on a real PC (PORTING-PLATFORMS.md, WP5).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { launch, outputDir, platform, settled, step, type Fixture } from './check-harness.ts'

const here = import.meta.dir
const APP_ID = 'dev.kybern.gpuix'
// A loose run (not beside the installer's uninstall.exe) posts under this id on Windows.
const WINDOWS_APP_ID = `${APP_ID}.dev`

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
      assert.equal(await text(f, 'identity'), APP_ID, 'Linux keeps the one id: it names the desktop entry and the icon')
      // The probe asks the server once for what it can do; a post does not ask again.
      const asked = await settled(async () => calls().filter(call => call.op === 'GetCapabilities').length, count => count >= 1, 4000)
      assert.equal(asked, 1, 'the capabilities are asked once, with the status probe')
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
      assert.equal(first!.hints?.['suppress-sound'], undefined)
    })
    await step('replace per thread', async () => {
      await clickPost(f, 'post-t1-b')
      await clickPost(f, 'post-t2')
      const list = await waitNotifies(3)
      assert.equal(list[1]!.summary, 'Fix login')
      assert.equal(list[1]!.replaces_id, list[0]!.id, 'the same thread replaces its notification')
      assert.equal(list[1]!.id, list[0]!.id)
      // It replaced a notification the user heard seconds ago: no second sound.
      assert.equal(list[1]!.hints?.['suppress-sound'], true)
      assert.equal(list[1]!.hints?.['sound-name'], undefined)
      assert.equal(list[2]!.hints?.['sound-name'], 'message-new-instant', 'another thread is a new notification with its sound')
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
    await step('two quick posts are one notification', async () => {
      const base = notifies().length
      await clickPost(f, 'post-t3-twice')
      const list = await waitNotifies(base + 2)
      assert.equal(list[base]!.summary, 'Docs')
      assert.equal(list[base]!.replaces_id, 0)
      assert.equal(list[base + 1]!.replaces_id, list[base]!.id, 'the second post carries the first one\'s id even though it was sent before the reply')
      assert.equal(list[base + 1]!.id, list[base]!.id)
    })
    await step('dismissing a thread closes its notification on the server', async () => {
      const base = notifies().length
      await clickPost(f, 'post-t2')
      const [posted] = (await waitNotifies(base + 1)).slice(-1)
      await clickPost(f, 'dismiss-t2')
      const closed = await settled(async () => calls().filter(call => call.op === 'Close'), list => list.length >= 1, 8000)
      assert.equal(closed.at(-1)!.id, posted!.id, 'CloseNotification names the thread\'s notification')
      // Nothing to withdraw: no second call.
      const before = calls().filter(call => call.op === 'Close').length
      await clickPost(f, 'dismiss-t2')
      await Bun.sleep(300)
      assert.equal(calls().filter(call => call.op === 'Close').length, before, 'a thread with nothing on screen closes nothing')
      await clickPost(f, 'post-t2')
      const next = await waitNotifies(base + 2)
      assert.equal(next[base + 1]!.replaces_id, 0, 'after the dismissal the thread starts a new notification')
      assert.equal(next[base + 1]!.hints?.['sound-name'], 'message-new-instant', 'a new notification after a dismissal has its sound')
    })
    await step('a restarted server is never sent a stale replaces_id', async () => {
      // t2 has a notification on the old server. The new one numbers from 1 again, so replacing id N would replace
      // whatever another application showed under N.
      const base = notifies().length
      const readies = calls().filter(call => call.op === 'ready').length
      command('restart')
      await settled(async () => calls().filter(call => call.op === 'ready').length, count => count > readies, 8000)
      await Bun.sleep(500)
      await clickPost(f, 'post-t2')
      const list = await waitNotifies(base + 1)
      assert.equal(list[base]!.replaces_id, 0, 'the thread\'s old id is forgotten with the old server')
      assert.equal(list[base]!.id, 1, 'the new server numbered from 1 again')
      await clickPost(f, 'post-t2')
      const again = await waitNotifies(base + 2)
      assert.equal(again[base + 1]!.replaces_id, list[base]!.id, 'replacement works again on the new server')
    })
    await f.close()
    // A server that does not read markup must not be sent entities it would print.
    command('caps actions body sound')
    f = await launch(path.join(here, 'notify-lab.tsx'))
    await step('a server without body-markup gets the body as written', async () => {
      await f.app.getByTestId('ready').waitFor()
      assert.equal(await waitText(f, 'status', value => value !== 'pending'), 'host:granted')
      const base = notifies().length
      await clickPost(f, 'post-t1-a')
      const list = await waitNotifies(base + 1)
      assert.equal(list[base]!.body, 'Needs approval: run <tests> & lint')
    })
    console.log('ok  Linux: Notify fields, replace per thread, one notification for quick posts, no second sound, dismiss, server restart, ActionInvoked once per click, markup only where read, unsupported without a daemon')
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
      assert.equal(await text(f, 'identity'), WINDOWS_APP_ID, 'a loose run posts under its own id, not the installed app\'s')
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
      const result = spawnSync('reg', ['query', `HKCU\\Software\\Classes\\AppUserModelId\\${WINDOWS_APP_ID}`, '/v', 'DisplayName'], { encoding: 'utf8' })
      assert.equal(result.status, 0, `no AppUserModelId registry entry: ${result.stderr}`)
      assert.match(result.stdout, /DisplayName\s+REG_SZ\s+Kybern \(dev\)/)
      const installed = spawnSync('reg', ['query', `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`], { encoding: 'utf8' })
      assert.notEqual(installed.status, 0, 'the installed app\'s registry key must not be created by a loose run')
    })
    // The action center keeps what the API accepted (readable on the windows-2022 runner too).
    const history = (count: string) => settled(async () => powershell(
      `[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]; ` +
      `@([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('${WINDOWS_APP_ID}')).Count`), value => value.out === count, 6000)
    await step('toasts in the history, one per thread', async () => {
      const found = await history('2')
      assert.equal(found.out, '2', `history: ${found.out} ${found.err}`)
    })
    await step('dismissing a thread removes its toast', async () => {
      await clickPost(f, 'dismiss-t1')
      const found = await history('1')
      assert.equal(found.out, '1', `history after the dismissal: ${found.out} ${found.err}`)
      await clickPost(f, 'dismiss-t1')
      assert.equal((await history('1')).out, '1', 'a thread with nothing on screen removes nothing')
    })
    // A user who cleared the action center (or swiped the toast away) leaves the app holding a toast Windows no longer
    // has. The next post for that thread used to hide it first, fail, and show nothing.
    await step('a post after the action center was cleared shows', async () => {
      const cleared = powershell(
        `[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]; ` +
        `[Windows.UI.Notifications.ToastNotificationManager]::History.Clear('${WINDOWS_APP_ID}')`)
      assert.equal(cleared.code, 0, `could not clear the history: ${cleared.err}`)
      assert.equal((await history('0')).out, '0')
      await clickPost(f, 'post-t2')
      await clickPost(f, 'post-t2')
      const found = await history('1')
      assert.equal(found.out, '1', `history after posting to a cleared action center: ${found.out} ${found.err}`)
    })
    console.log('ok  Windows: toast API with the dev AUMID, registry entry, posts, history, dismiss, post after a cleared action center')
  } catch (error) { console.error(f.diagnostics()); throw error } finally { await f.close() }
}

await (platform === 'linux' ? linux() : windows())
