import type { ThreadId } from "@/protocol"
import { previewContext } from "@/state/previewSession"
import type { PreviewTarget } from "@/state/store"
import { previewDisplay, type PreviewDisplaySegment } from "../../../../../../packages/kybern-client/src/previewTarget"

/** Where the page the user sees right now is, as text. Files follow the bridge's path. */
export function currentAddress(threadId: ThreadId, target: PreviewTarget, bridgePath: string | null): { segments: PreviewDisplaySegment[]; full: string } {
  if (target.kind === "server") {
    const url = new URL(target.url)
    const tail = `${url.pathname === "/" ? "" : url.pathname}${url.search}${url.hash}`
    return { segments: tail ? [{ text: url.host, emphasis: true }, { text: tail, emphasis: false }] : [{ text: url.host, emphasis: true }], full: target.url }
  }
  if (target.kind === "file") {
    const path = bridgePath ? `${target.root.replace(/\/+$/, "")}/${bridgePath}` : target.path
    const inside = target.inProject && path.startsWith(`${target.root}/`)
    const display = previewDisplay({ kind: "file", path, ...(inside ? { relative: path.slice(target.root.length + 1) } : {}) }, previewContext(threadId))
    return { segments: display.segments, full: path }
  }
  const url = new URL(target.url)
  return { segments: [{ text: target.query ?? url.host, emphasis: true }], full: target.query ?? target.url }
}
