import { dlopen, FFIType, JSCallback, ptr } from 'bun:ffi'
import path from 'node:path'
import { existsSync } from 'node:fs'
export type NotificationStatus = 'unsupported' | 'not-determined' | 'denied' | 'granted'
export interface NativeNotification { id: string; title: string; body: string }
const listeners = new Set<(id: string) => void>()
const pending = new Map<number, {resolve: (value: unknown) => void; reject: (error: Error) => void}>()
let sequence = 0
let reason: string | undefined
let bridge: ReturnType<typeof load> | undefined
let callback: JSCallback | undefined
let attempted = false
function load(file: string) {
  return dlopen(file, {
    kybern_notifications_init: {args:[FFIType.ptr], returns:FFIType.i32},
    kybern_notifications_next: {args:[], returns:FFIType.cstring},
    kybern_notifications_command: {args:[FFIType.ptr], returns:FFIType.void},
  })
}
function initialize() {
  if (attempted) return !!bridge
  attempted = true
  const resources = path.resolve(path.dirname(process.execPath), '../Resources')
  const file = path.join(resources, 'notifications.dylib')
  if (process.platform !== 'darwin' || !process.execPath.includes('.app/Contents/MacOS/') || !existsSync(file)) {
    reason = 'OS notifications require the packaged Kybern GPUIX.app (dev.kybern.gpuix)'
    return false
  }
  try {
    const loaded = load(file)
    callback = new JSCallback(() => {
      for (;;) {
        const raw = loaded.symbols.kybern_notifications_next()
        if (!raw) break
        const event = JSON.parse(String(raw))
        if (typeof event.click === 'string') {
          for (const listener of listeners) { try { listener(event.click) } catch (error) { console.error('[notifications] click handler:', error) } }
        } else {
          const request = pending.get(event.token)
          pending.delete(event.token)
          if (event.error) request?.reject(Error(event.error)); else request?.resolve(event.value)
        }
      }
    }, {args:[], returns:FFIType.void, threadsafe:true})
    if (!loaded.symbols.kybern_notifications_init(callback.ptr)) {
      callback.close(); loaded.close(); reason = 'The executable has no dev.kybern.gpuix bundle identity'; return false
    }
    bridge = loaded
    return true
  } catch (error) { reason = String(error); return false }
}
function command(op: string, fields = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const token = ++sequence
    const timer = setTimeout(() => {pending.delete(token); reject(Error('Notification service timed out'))}, 120000)
    pending.set(token, {resolve:value => {clearTimeout(timer); resolve(value)}, reject:error => {clearTimeout(timer); reject(error)}})
    const bytes = Buffer.from(JSON.stringify({op, token, ...fields}) + '\0')
    bridge!.symbols.kybern_notifications_command(ptr(bytes))
  })
}
export const notifications = {
  get reason() { initialize(); return reason },
  async status(): Promise<NotificationStatus> { return initialize() ? await command('status') as NotificationStatus : 'unsupported' },
  async requestPermission(): Promise<NotificationStatus> { return initialize() ? await command('permission') as NotificationStatus : 'unsupported' },
  async post(notification: NativeNotification): Promise<boolean> {
    if (!initialize() || await this.status() !== 'granted') return false
    if (!notification.id) throw Error('Notification id must not be empty')
    return await command('post', notification) as boolean
  },
  onClick(callback: (id: string) => void): () => void { listeners.add(callback); return () => {listeners.delete(callback)} },
}
