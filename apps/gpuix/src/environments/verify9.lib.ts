/** Shared driver for the settings9 environment checks: scratch daemons A (4294) and B (4295), isolated registry and credentials. */
import { launch } from '@gpuix/react/automation'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

export const S = '/Users/mymac/projects/ade-gpuix-scratch'
export const OUT = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/gpuix/phase2/settings9/envs'
export const DATA_A = `${S}/phase2-settings9`
export const DATA_B = `${S}/phase2-settings9-b`
export const CLIENT = process.env.KYBERN_CLIENT_CONFIG_DIR ?? `${S}/phase2-settings9-client`
export const CREDS = process.env.KYBERN_GPUIX_CREDENTIALS_DIR ?? `${S}/phase2-settings9-creds`
const CLI = '/Applications/kybern.app/Contents/MacOS/kybern'
export const cli = (data: string, ...args: string[]) => execFileSync(CLI, ['--data-dir', data, ...args], { encoding: 'utf8' })
export const pairingInvitation = (data = DATA_B, address = 'http://127.0.0.1:4295') => (JSON.parse(cli(data, '--json', 'pair', '--address', address)) as { addresses: { invitation: string }[] }).addresses[0]!.invitation

export const mode = process.env.KYBERN_APPEARANCE ?? process.argv[2] ?? 'dark'
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
export function reset() { rmSync(CLIENT, { recursive: true, force: true }); rmSync(CREDS, { recursive: true, force: true }); rmSync(`${DATA_A}/gpuix-ui.json`, { force: true }) }

export async function start(extra: Record<string, string> = {}) {
  mkdirSync(OUT, { recursive: true })
  const app = await launch({ command: 'bun', args: ['src/main.tsx'], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: mode, KYBERN_DATA_DIR: DATA_A, KYBERN_CLIENT_CONFIG_DIR: CLIENT, KYBERN_GPUIX_CREDENTIALS_DIR: CREDS, ...extra } })
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  const until = async (label: string, check: () => Promise<boolean>, ms = 30_000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await check()) return } catch { /* retry */ } await wait(60) } throw Error(`Timed out: ${label}`) }
  const present = (id: string) => app.getByTestId(id).count().then((n) => n > 0)
  const click = async (id: string) => { await until(`click ${id}`, async () => { if (!(await present(id))) return false; await app.getByTestId(id).click(); return true }) }
  const text = async (value: string) => (await app.getByText(value).count()) > 0 || JSON.stringify(await app.call('getPaintedText', {})).includes(value)
  const shot = (name: string) => app.screenshot({ path: path.join(OUT, `${name}-${mode}.png`) })
  return { app, until, present, click, text, shot }
}

/** Add daemon B as "Second machine" through the real Add environment dialog (address tab, pairing invitation). */
export async function addSecond(h: Awaited<ReturnType<typeof start>>) {
  await toHome(h)
  await h.click('environment-switcher'); await h.click('environment-add'); await h.click('environment-tab-address')
  await h.app.getByTestId('environment-name').fill('Second machine')
  await h.app.getByTestId('environment-address').fill(pairingInvitation())
  await h.click('environment-save')
  await h.until('connected to B', () => h.text('proj9b'), 30_000)
  return (JSON.parse(readFileSync(path.join(CLIENT, 'environments.json'), 'utf8')) as { environments: { id: string }[] }).environments[0]!.id
}
export const switchTo = async (h: Awaited<ReturnType<typeof start>>, id: string, marker: string) => { await toHome(h); await h.click('environment-switcher'); await h.click(`environment-choice-${id}`); await h.until(`on ${id}`, () => h.text(marker), 30_000); await wait(700) }

/** A titled thread in a scratch daemon's first project (no message is sent, so no agent turn runs). */
export function ensureThread(data: string, title: string) {
  const projects = (JSON.parse(cli(data, 'call', 'projects.list', '{}')) as { projects: { id: string }[] }).projects
  const existing = (JSON.parse(cli(data, 'call', 'threads.list', '{}')) as { threads: { id: string; title: string }[] }).threads.find(t => t.title === title)
  if (existing) return existing.id
  return (JSON.parse(cli(data, 'call', 'threads.create', JSON.stringify({ project_id: projects[0]!.id, provider: { kind: 'claude-code', instance: 'default' }, title }))) as { id: string }).id
}

/** The environment switcher lives in the thread panel: go Home (once per attempt) until it shows. */
export async function toHome(h: Awaited<ReturnType<typeof start>>) {
  for (let attempt = 0; attempt < 6 && !(await h.present('environment-switcher')); attempt++) { await h.click('rail-home'); await wait(500) }
}
