import { mkdirSync, readFileSync, renameSync, writeFileSync, watch } from 'node:fs'
import path from 'node:path'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { configDir, localEndpoint } from '../environments/registry.ts'
import { activeEnvironment, onEnvironmentChange } from '../shell/environment.ts'

const file = () => path.join(configDir(), 'notes-preferences.json')
function readHome(): 'shared' | 'separate' {
  try { return JSON.parse(readFileSync(file(), 'utf8')).globalHome === 'separate' ? 'separate' : 'shared' } catch { return 'shared' }
}
export function setGlobalNotesHome(value: 'shared' | 'separate') {
  mkdirSync(configDir(), { recursive: true })
  const temp = `${file()}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify({ globalHome: value }), { mode: 0o600 })
  renameSync(temp, file())
  observed = value
  closeHome()
  subscribers.forEach((changed) => changed())
}
export const sharesHome = () => activeEnvironment().id !== 'local' && globalNotesHome() === 'shared'
const subscribers = new Set<() => void>()
let observed = readHome()
export function globalNotesHome() { return observed }
let client: KybernClient | null = null
function closeHome() { client?.close(); client = null }
onEnvironmentChange(closeHome)
/** Only Global notes use this connection. Never silently redirect an unavailable home to the remote daemon. */
export function homeClient(changed: () => void) {
  if (!client) {
    client = new KybernClient(localEndpoint())
    client.onNotification('notes.changed', changed)
    client.onStatus((status) => { if (status === 'open') changed() })
    client.connect()
  }
  return client
}

export function onGlobalNotesHomeChange(changed: () => void) {
  subscribers.add(changed)
  return () => { subscribers.delete(changed) }
}

export function watchGlobalNotesHome(changed: () => void) {
  mkdirSync(configDir(), { recursive: true })
  subscribers.add(changed)
  const watcher = watch(configDir(), (_event, name) => {
    if (name !== 'notes-preferences.json') return
    const next = readHome()
    if (next === observed) return
    observed = next; closeHome(); subscribers.forEach((notify) => notify())
  })
  return () => { subscribers.delete(changed); watcher.close() }
}
