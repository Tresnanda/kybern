// Small stand-ins for Synara's hooks so its sidebar primitive ports unchanged.

import { useSyncExternalStore } from "react"

const MOBILE_QUERY = "(max-width: 767px)"

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(MOBILE_QUERY)
      mq.addEventListener("change", cb)
      return () => mq.removeEventListener("change", cb)
    },
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  )
}

/** Minimal codec shape; Synara passes `Schema.Finite` etc. We only need JSON. */
export const Schema = {
  Finite: "number" as const,
  Number: "number" as const,
  Boolean: "boolean" as const,
  String: "string" as const,
}
type Codec = (typeof Schema)[keyof typeof Schema]

export function getLocalStorageItem<T = unknown>(key: string, codec?: Codec): T | null {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return null
    const value = JSON.parse(raw) as unknown
    if (codec && typeof value !== codec) return null
    return value as T
  } catch {
    return null
  }
}

export function setLocalStorageItem(key: string, value: unknown, _codec?: Codec): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore
  }
}
