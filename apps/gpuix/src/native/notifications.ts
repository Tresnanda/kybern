import { dlopen, FFIType, JSCallback, ptr } from 'bun:ffi'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { installedWindowsFolder } from '../platform/windowsInstall.ts'
export type NotificationStatus = 'unsupported' | 'not-determined' | 'denied' | 'granted'
/**
 * `group`: posts that share a group replace each other on Windows (the toast tag) and Linux (`replaces_id`), so an
 * agent that finishes after asking leaves one notification per thread. macOS keeps one per id. `dismiss(group)` withdraws
 * what a group has on screen.
 */
export interface NativeNotification { id: string; title: string; body: string; group?: string }

// ---- Windows and Linux: GPUI's notifications through the addon (WP5) ----
// Windows: toasts under the AppUserModelID the installer's Start-menu shortcut carries. Linux: freedesktop
// `Notify` with `replaces_id` per group and `ActionInvoked` for a click. The native side raises the window before
// it reports the click, as the macOS delegate does. macOS keeps its UserNotifications companion below.

/** The identity both the Windows shortcut (`packaging/windows/shortcut.ps1`) and the Linux desktop entry use. */
export const NOTIFICATION_APP_ID = 'dev.kybern.gpuix'
export const NOTIFICATION_APP_NAME = 'Kybern'
/**
 * The identity a run posts under. An installed Windows copy owns `dev.kybern.gpuix`: the installer writes its registry
 * key (display name, icon) and the Start-menu shortcut carries it, and the user's per-app toast setting hangs on it. A
 * portable, dev or CI run must not recreate that key or share the setting, so it takes a suffixed id, and a
 * "(dev)" name that says which Kybern the toast came from. Linux keeps the one id: it is the desktop entry and icon name.
 */
export function notificationIdentity(platform: NodeJS.Platform, installed: boolean): { id: string; name: string } {
  if (platform === 'win32' && !installed) return { id: `${NOTIFICATION_APP_ID}.dev`, name: `${NOTIFICATION_APP_NAME} (dev)` }
  return { id: NOTIFICATION_APP_ID, name: NOTIFICATION_APP_NAME }
}
/** This process's identity: on Windows the installed copy is the one beside `uninstall.exe` (`platform/windowsInstall.ts`). */
export const currentNotificationIdentity = () =>
  notificationIdentity(process.platform, process.platform === 'win32' && installedWindowsFolder() !== null)

/** A body longer than this is cut: toasts and shells clip long text anyway, and an error dump should not flood. */
export const BODY_LIMIT = 600
const STATUS_TTL_MS = 10_000
/** A second post for a thread within this long of its last one replaces it without a sound. */
export const QUIET_REPLACE_MS = 10_000
/** Posts remembered per group: a click on one older than this falls back to the group itself. */
const ID_LIMIT = 256

/** The slice of the addon's renderer the host backend calls. All of it is Windows and Linux only. */
export interface NotificationHost {
  setAppIdentity(identifier: string, name: string): void
  /** `silent`: no sound (a replacement of a notification the user just heard). Addons before it ignore the argument. */
  showSystemNotification(tag: string, title: string, body: string, silent?: boolean): void
  dismissSystemNotification(tag: string): void
  setSystemNotificationCallback(callback: ((error: Error | null, event?: { tag: string; action: string | null }) => void) | null): void
  /**
   * The status name, or from an addon that also asks the Linux server whether bodies are markup, `{ status, markup }`
   * (as the JSON text the addon resolves, or the parsed object).
   */
  systemNotificationStatus(identifier: string): Promise<string | { status: string; markup?: boolean | null }>
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

/**
 * Give the addon the notification identity before its window exists (`main.tsx`, ahead of `render`). On Windows the
 * process AppUserModelID must be set before the first window is created for the taskbar to group it, and every
 * environment window is its own process that starts here. A no-op on macOS, on the stock addon, or when it cannot load.
 */
export function setEarlyAppIdentity(identity = currentNotificationIdentity(), platform: NodeJS.Platform = process.platform): boolean {
  const file = process.env.NAPI_RS_NATIVE_LIBRARY_PATH
  if (platform === 'darwin' || !file) return false
  try {
    const addon = createRequire(import.meta.url)(file) as { kybernSetAppIdentity?: (identifier: string, name: string) => void }
    if (typeof addon.kybernSetAppIdentity !== 'function') return false
    addon.kybernSetAppIdentity(identity.id, identity.name)
    return true
  } catch { return false }
}

const escapeMarkup = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** Control characters other than newline and tab have no place in a notification. */
const clean = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
const clip = (text: string, limit: number) => {
  const chars = [...text]
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('').trimEnd()}…` : text
}

/**
 * What the addon is asked to post. The tag is the group (or the id): the native layer replaces by tag. A Linux server
 * that reads the body as markup (`<b>`, `<a>`) gets a bare `&` or `<` from an agent's error text escaped; one that
 * does not advertise `body-markup` gets the text as it is, since it would print the entities. `markup` is what the
 * server said (null: it could not, so escape). Windows toasts take plain text.
 */
export function hostPayload(notification: NativeNotification, platform: NodeJS.Platform, markup: boolean | null = null): { tag: string; title: string; body: string } {
  const title = clip(clean(notification.title).replace(/\s+/g, ' ').trim(), 120)
  const body = clip(clean(notification.body).trim(), BODY_LIMIT)
  return { tag: notification.group || notification.id, title, body: platform === 'win32' || markup === false ? body : escapeMarkup(body) }
}

/** The sentence `notifications.reason` gives for a status the host reported. */
export function hostReason(platform: NodeJS.Platform, status: NotificationStatus): string | undefined {
  if (status === 'granted') return undefined
  if (status === 'denied') return platform === 'win32' ? 'Notifications for Kybern are turned off in Windows settings' : 'Notifications for Kybern are turned off'
  return platform === 'win32' ? 'Windows could not show notifications for Kybern' : 'No notification service is running (org.freedesktop.Notifications)'
}

/** What `systemNotificationStatus` resolved: a bare status name, `{ status, markup }`, or that object as JSON text. */
export function parseHostStatus(answer: string | { status: string; markup?: boolean | null }): { status: string; markup: boolean | null } {
  let value: unknown = answer
  if (typeof answer === 'string' && answer.startsWith('{')) { try { value = JSON.parse(answer) } catch { /* a bare name */ } }
  if (typeof value === 'string') return { status: value, markup: null }
  const { status, markup } = value as { status?: unknown; markup?: unknown }
  return { status: typeof status === 'string' ? status : 'unsupported', markup: typeof markup === 'boolean' ? markup : null }
}

const asStatus = (value: string): NotificationStatus => value === 'granted' || value === 'denied' || value === 'not-determined' ? value : 'unsupported'

export interface HostBackendOptions {
  host: NotificationHost
  platform: NodeJS.Platform
  /** The identity to post under; defaults to this process's. */
  identity?: { id: string; name: string }
  now?: () => number
  /** Diagnostics, off unless `KYBERN_DEBUG_NOTIFICATIONS` is set. */
  debug?: (...args: unknown[]) => void
}

/**
 * The Windows/Linux implementation of the same interface the macOS companion serves. Pure over its options: tests pass a
 * fake host and a platform.
 */
export function createHostBackend({ host, platform, identity = currentNotificationIdentity(), now = Date.now, debug = () => {} }: HostBackendOptions) {
  const listeners = new Set<(id: string) => void>()
  /** The id last posted under each tag, so a click on a replaced notification reports the one that is on screen. Oldest first. */
  const ids = new Map<string, string>()
  /** When each tag was last posted: a replacement soon after is quiet. */
  const postedAt = new Map<string, number>()
  let reason: string | undefined
  let markup: boolean | null = null
  let cached: { status: NotificationStatus; at: number } | undefined
  let ready = false
  const prepare = () => {
    if (ready) return
    host.setAppIdentity(identity.id, identity.name)
    host.setSystemNotificationCallback((error, event) => {
      if (error || !event) { if (error) console.error('[notifications] click:', error); return }
      // A tag past the cap reports as itself, and the app opens that group's thread.
      const id = ids.get(event.tag) ?? event.tag
      debug('click', event.tag, id)
      for (const listener of [...listeners]) { try { listener(id) } catch (failure) { console.error('[notifications] click handler:', failure) } }
    })
    ready = true
  }
  /** One probe at a time: the startup warm-up and the first post would otherwise each ask the service. */
  let probing: Promise<NotificationStatus> | undefined
  const status = (): Promise<NotificationStatus> => {
    if (cached && now() - cached.at < STATUS_TTL_MS) return Promise.resolve(cached.status)
    return probing ??= probe().finally(() => { probing = undefined })
  }
  const probe = async (): Promise<NotificationStatus> => {
    let value: NotificationStatus
    let failure: string | undefined
    try {
      prepare()
      const answer = parseHostStatus(await host.systemNotificationStatus(identity.id))
      value = asStatus(answer.status)
      markup = answer.markup
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
      const payload = hostPayload(notification, platform, markup)
      const at = now()
      const last = postedAt.get(payload.tag)
      const quiet = last !== undefined && at - last < QUIET_REPLACE_MS
      ids.delete(payload.tag)
      ids.set(payload.tag, notification.id)
      if (ids.size > ID_LIMIT) ids.delete(ids.keys().next().value!)
      postedAt.delete(payload.tag)
      postedAt.set(payload.tag, at)
      if (postedAt.size > ID_LIMIT) postedAt.delete(postedAt.keys().next().value!)
      host.showSystemNotification(payload.tag, payload.title, payload.body, quiet)
      return true
    },
    /** Withdraws what `group` has on screen. Nothing happens for a group with nothing posted. */
    async dismiss(group: string): Promise<void> {
      if (!ready) return
      ids.delete(group)
      postedAt.delete(group)
      host.dismissSystemNotification(group)
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
    const posted = await command('post', { id, title, body }) as boolean
    if (posted) remember(notification.group || id, id)
    return posted
  },
  /** Removes what a group has in the notification center: its posts are separate notifications here, so each id goes. */
  async dismiss(group: string): Promise<void> {
    const list = [...(shown.get(group) ?? [])]
    shown.delete(group)
    if (!list.length || !initialize()) return
    await command('dismiss', { ids: list })
  },
  onClick(callback: (id: string) => void): () => void { listeners.add(callback); return () => {listeners.delete(callback)} },
}
/** The ids posted per group, newest last, for `dismiss`. Bounded: a group keeps its last few, and the map its last 256. */
const shown = new Map<string, string[]>()
function remember(group: string, id: string) {
  const list = (shown.get(group) ?? []).filter(known => known !== id)
  list.push(id)
  shown.delete(group)
  shown.set(group, list.slice(-8))
  if (shown.size > 256) shown.delete(shown.keys().next().value!)
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
  /** Withdraws the notification a group (a thread) has on screen, e.g. once its approval was answered. Never throws. */
  async dismiss(group: string): Promise<void> { try { await active()?.dismiss(group) } catch (error) { console.error('[notifications] dismiss:', error) } },
  onClick(callback: (id: string) => void): () => void {
    if (process.platform === 'darwin') return companion.onClick(callback)
    // Kept here so a listener added before the addon is attached still hears clicks.
    clickListeners.add(callback)
    return () => { clickListeners.delete(callback) }
  },
}
