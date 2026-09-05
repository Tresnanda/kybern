// Native bridge. Every call degrades gracefully when the page runs in a plain
// browser (vite dev without Tauri), so the UI can be iterated outside the shell.

export interface EndpointInfo {
  url: string
  http_base: string
  token: string
  spawned: boolean
}

export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

export async function resolveEndpoint(): Promise<EndpointInfo> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core")
    return invoke<EndpointInfo>("endpoint")
  }
  // Browser dev: read from the URL (`?url=ws://...&token=...`) or Vite env.
  const q = new URLSearchParams(window.location.search)
  const url = q.get("url") ?? import.meta.env.VITE_KYBERN_URL ?? "ws://127.0.0.1:4173/ws"
  const token = q.get("token") ?? import.meta.env.VITE_KYBERN_TOKEN ?? ""
  return { url, token, http_base: url.replace(/^ws/, "http").replace(/\/ws$/, ""), spawned: false }
}

export type NotificationPermissionState = "granted" | "denied" | "default" | "unavailable"

export async function notificationPermission(request = false): Promise<NotificationPermissionState> {
  if (isTauri()) {
    if (platform() === "macos") {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<NotificationPermissionState>("notification_permission", { request })
    }
    const n = await import("@tauri-apps/plugin-notification")
    if (await n.isPermissionGranted()) return "granted"
    if (!request) return "default"
    return (await n.requestPermission()) === "granted" ? "granted" : "denied"
  }
  if (!("Notification" in window)) return "unavailable"
  return request ? Notification.requestPermission() : Notification.permission
}

export async function notify(title: string, body: string): Promise<boolean> {
  try {
    if (await notificationPermission() !== "granted") return false
    if (isTauri()) {
      if (platform() === "macos") {
        const { invoke } = await import("@tauri-apps/api/core")
        await invoke("send_notification", { title, body })
      } else {
        const n = await import("@tauri-apps/plugin-notification")
        n.sendNotification({ title, body })
      }
    } else new Notification(title, { body })
    return true
  } catch { return false }
}

export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener")
    return openUrl(url)
  }
  window.open(url, "_blank", "noopener")
}

export async function openPath(path: string): Promise<void> {
  const { activeEnvironment } = await import("@/state/environments")
  if (!activeEnvironment()?.local) return
  if (!isTauri()) return
  const { openPath: open } = await import("@tauri-apps/plugin-opener")
  return open(path)
}

export async function revealInFinder(path: string): Promise<void> {
  const { activeEnvironment } = await import("@/state/environments")
  if (!activeEnvironment()?.local) return
  if (!isTauri()) return
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener")
  return revealItemInDir(path)
}

export async function pickFolder(): Promise<string | null> {
  if (!isTauri()) return window.prompt("Folder path") || null
  const { open } = await import("@tauri-apps/plugin-dialog")
  const r = await open({ directory: true, multiple: false })
  return typeof r === "string" ? r : null
}

export async function pickFiles(): Promise<string[]> {
  if (!isTauri()) return []
  const { open } = await import("@tauri-apps/plugin-dialog")
  const r = await open({ multiple: true })
  return Array.isArray(r) ? r : r ? [r] : []
}

export async function startDragging(): Promise<void> {
  if (!isTauri()) return
  const { getCurrentWindow } = await import("@tauri-apps/api/window")
  return getCurrentWindow().startDragging()
}

export async function isWindowFocused(): Promise<boolean> {
  if (!isTauri()) return document.hasFocus()
  const { getCurrentWindow } = await import("@tauri-apps/api/window")
  return getCurrentWindow().isFocused()
}

export const platform = (): "macos" | "windows" | "linux" | "web" => {
  const ua = navigator.userAgent
  if (/Mac/.test(ua)) return "macos"
  if (/Win/.test(ua)) return "windows"
  if (/Linux/.test(ua)) return "linux"
  return "web"
}
