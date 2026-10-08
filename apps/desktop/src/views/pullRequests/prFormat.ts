import { relativeTime } from "@/lib/format"

/** "3d ago", "just now", or "on Oct 3" for older dates. */
export function agoPhrase(iso: string | undefined | null): string {
  if (!iso) return ""
  const r = relativeTime(iso)
  if (!r) return ""
  if (r === "now") return "just now"
  return /^\d+[mhdw]$/.test(r) ? `${r} ago` : `on ${r}`
}
