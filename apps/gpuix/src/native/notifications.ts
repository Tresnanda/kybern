import { dlopen, FFIType, JSCallback, ptr } from 'bun:ffi'
import path from 'node:path'
import { existsSync } from 'node:fs'
export type NotificationStatus = 'unsupported' | 'not-determined' | 'denied' | 'granted'
/**
 * `group`: posts that share a group replace each other on Windows (the toast tag) and Linux (`replaces_id`), so an
 * agent that finishes after asking leaves one notification per thread. macOS keeps one per id.
 */
export interface NativeNotification { id: string; title: string; body: string; group?: string }

// ---- Windows and Linux: GPUI's notifications through the addon (WP5) ----
// Windows: toasts under the AppUserModelID the installer's Start-menu shortcut carries. Linux: freedesktop
// `Notify` with `replaces_id` per group and `ActionInvoked` for a click. The native side raises the window before
// it reports the click, as the macOS delegate does. macOS keeps its UserNotifications companion below.

/** The identity both the Windows shortcut (`packaging/windows/shortcut.ps1`) and the Linux desktop entry use. */
export const NOTIFICATION_APP_ID = 'dev.kybern.gpuix'
export const NOTIFICATION_APP_NAME = 'Kybern'
/** A body longer than this is cut: toasts and shells clip long text anyway, and an error dump should not flood. */
export const BODY_LIMIT = 600
const STATUS_TTL_MS = 10_000

/** The slice of the addon's renderer the host backend calls. All of it is Windows and Linux only. */
export interface NotificationHost {
  setAppIdentity(identifier: string, name: string): void
  showSystemNotification(tag: string, title: string, body: string): void
  dismissSystemNotification(tag: string): void
  setSystemNotificationCallback(callback: ((error: Error | null, event?: { tag: string; action: string | null }) => void) | null): void
  systemNotificationStatus(identifier: string): Promise<string>
}
export type NotificationBackend = 'companion' | 'host' | 'none'

/** Which implementation serves a platform. `host` is whether the addon exposes the notification methods. */
export function chooseBackend(platform: NodeJS.Platform, host: boolean): NotificationBackend {
  if (platform === 'darwin') return 'companion'
  return (platform === 'win32' || platform === 'linux' || platform === 'freebsd') && host ? 'host' : 'none'
}

/** Does the renderer carry the notification methods (an addon built from the fork's `wp5` commits or later)? */
export function isNotificationHost(renderer: unknown): renderer is NotificationHost {
  const host = renderer as Partial<Record<keyof NotificationHost, unknown>> | null
  return !!host && (['setAppIdentity', 'showSystemNotification', 'dismissSystemNotification', 'setSystemNotificationCallback', 'systemNotificationStatus'] as const)
    .every(method => typeof host[method] === 'function')
}

const escapeMarkup = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** Control characters other than newline and tab have no place in a notification. */
const clean = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
const clip = (text: string, limit: number) => {
  const chars = [...text]
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('').trimEnd()}…` : text
}

/**
 * What the addon is asked to post. The tag is the group (or the id): the native layer replaces by tag. Linux servers
 * read the body as markup (`<b>`, `<a>`), so a bare `&` or `<` from an agent's error text is escaped there; Windows
 * toasts take plain text.
 */
export function hostPayload(notification: NativeNotification, platform: NodeJS.Platform): { tag: string; title: string; body: string } {
  const title = clip(clean(notification.title).replace(/\s+/g, ' ').trim(), 120)
  const body = clip(clean(notification.body).trim(), BODY_LIMIT)
  return { tag: notification.group || notification.id, title, body: platform === 'win32' ? body : escapeMarkup(body) }
}

/** The sentence `notifications.reason` gives for a status the host reported. */
export function hostReason(platform: NodeJS.Platform, status: NotificationStatus): string | undefined {
  if (status === 'granted') return undefined
  if (status === 'denied') return platform === 'win32' ? 'Notifications for Kybern are turned off in Windows settings' : 'Notifications for Kybern are turned off'
  return platform === 'win32' ? 'Windows could not show notifications for Kybern' : 'No notification service is running (org.freedesktop.Notifications)'
}

const asStatus = (value: string): NotificationStatus => value === 'granted' || value === 'denied' || value === 'not-determined' ? value : 'unsupported'

export interface HostBackendOptions {
  host: NotificationHost
  platform: NodeJS.Platform
  now?: () => number
  /** Diagnostics, off unless `KYBERN_DEBUG_NOTIFICATIONS` is set. */
  debug?: (...args: unknown[]) => void
}

/**
 * The Windows/Linux implementation of the same interface the macOS companion serves. Pure over its options: tests pass a
 * fake host and a platform.
 */
export function createHostBackend({ host, platform, now = Date.now, debug = () => {} }: HostBackendOptions) {
  const listeners = new Set<(id: string) => void>()
  /** The id last posted under each tag, so a click on a replaced notification reports the one that is on screen. */
  const ids = new Map<string, string>()
  let reason: string | undefined
  let cached: { status: NotificationStatus; at: number } | undefined
  let ready = false
  const prepare = () => {
    if (ready) return
    host.setAppIdentity(NOTIFICATION_APP_ID, NOTIFICATION_APP_NAME)
    host.setSystemNotificationCallback((error, event) => {
      if (error || !event) { if (error) console.error('[notifications] click:', error); return }
      const id = ids.get(event.tag) ?? event.tag
      debug('click', event.tag, id)
      for (const listener of [...listeners]) { try { listener(id) } catch (failure) { console.error('[notifications] click handler:', failure) } }
    })
    ready = true
  }
  const status = async (): Promise<NotificationStatus> => {
    if (cached && now() - cached.at < STATUS_TTL_MS) return cached.status
    let value: NotificationStatus
    let failure: string | undefined
    try {
      prepare()
      value = asStatus(await host.systemNotificationStatus(NOTIFICATION_APP_ID))
    } catch (error) {
      debug('status failed', error)
      value = 'unsupported'
      failure = `Notifications are unavailable: ${error instanceof Error ? error.message : String(error)}`
    }
    reason = failure ?? hostReason(platform, value)
    cached = { status: value, at: now() }
    return value
  }
  return {
    get reason() { return reason },
    status,
    /** Nothing to ask on these systems: the user's own notification settings decide, and `status` reports them. */
    requestPermission: status,
    async post(notification: NativeNotification): Promise<boolean> {
      if (!notification.id) throw Error('Notification id must not be empty')
      if (await status() !== 'granted') return false
      const payload = hostPayload(notification, platform)
      ids.set(payload.tag, notification.id)
      if (ids.size > 256) ids.delete(ids.keys().next().value!)
      host.showSystemNotification(payload.tag, payload.title, payload.body)
      return true
    },
    onClick(callback: (id: string) => void): () => void { listeners.add(callback); return () => { listeners.delete(callback) } },
  }
}

// ---- macOS: the UserNotifications companion (unchanged) ----
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
const companion = {
  get reason() { initialize(); return reason },
  async status(): Promise<NotificationStatus> { return initialize() ? await command('status') as NotificationStatus : 'unsupported' },
  async requestPermission(): Promise<NotificationStatus> { return initialize() ? await command('permission') as NotificationStatus : 'unsupported' },
  async post(notification: NativeNotification): Promise<boolean> {
    if (!initialize() || await this.status() !== 'granted') return false
    if (!notification.id) throw Error('Notification id must not be empty')
    const { id, title, body } = notification
    return await command('post', { id, title, body }) as boolean
  },
  onClick(callback: (id: string) => void): () => void { listeners.add(callback); return () => {listeners.delete(callback)} },
}

// ---- the app's entry point ----
let hostBackend: ReturnType<typeof createHostBackend> | undefined
const clickListeners = new Set<(id: string) => void>()
const debug = (...args: unknown[]) => { if (process.env.KYBERN_DEBUG_NOTIFICATIONS) console.error('[notifications]', ...args) }

/**
 * Give Windows and Linux the addon's renderer (`main.tsx`, next to `setOsHost`). An addon without the notification
 * methods leaves them unsupported, and the in-app toasts carry on alone. Returns the backend that now serves.
 */
export function attachNotificationHost(renderer: unknown): NotificationBackend {
  const backend = chooseBackend(process.platform, isNotificationHost(renderer))
  if (backend === 'host' && !hostBackend) {
    hostBackend = createHostBackend({ host: renderer as NotificationHost, platform: process.platform, debug })
    hostBackend.onClick(id => { for (const listener of [...clickListeners]) listener(id) })
    // The process identity (Windows toasts and taskbar grouping, the Linux desktop entry) is set by the first query, which
    // this makes now, before anything can post.
    void hostBackend.status().catch(() => {})
  }
  return backend
}

const active = () => process.platform === 'darwin' ? companion : hostBackend
export const notifications = {
  get reason() { const backend = active(); return backend ? backend.reason : 'OS notifications need the GPUIX addon with system notification support' },
  async status(): Promise<NotificationStatus> { return active()?.status() ?? 'unsupported' },
  async requestPermission(): Promise<NotificationStatus> { return active()?.requestPermission() ?? 'unsupported' },
  async post(notification: NativeNotification): Promise<boolean> { return active()?.post(notification) ?? false },
  onClick(callback: (id: string) => void): () => void {
    if (process.platform === 'darwin') return companion.onClick(callback)
    // Kept here so a listener added before the addon is attached still hears clicks.
    clickListeners.add(callback)
    return () => { clickListeners.delete(callback) }
  },
}
