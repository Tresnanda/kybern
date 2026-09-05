// Whether closing the window while threads work should ask first. A local
// preference: it is about this window, not the daemon, so it lives in the
// browser store rather than settings.json.

import { useSyncExternalStore } from "react"

const KEY = "kybern.askBeforeClose"
const listeners = new Set<() => void>()

function read(): boolean {
  try { return localStorage.getItem(KEY) !== "0" } catch { return true }
}

export function askBeforeClose(): boolean {
  return read()
}

export function setAskBeforeClose(ask: boolean): void {
  try { if (ask) localStorage.removeItem(KEY); else localStorage.setItem(KEY, "0") } catch { /* private mode */ }
  for (const listener of listeners) listener()
}

export function useAskBeforeClose(): boolean {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener) }, read, () => true)
}
