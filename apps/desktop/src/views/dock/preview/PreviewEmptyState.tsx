import { useEffect, useState, useSyncExternalStore } from "react"
import { toast } from "sonner"

import { ScrollArea } from "@/components/kit/scroll-area"
import { FileIcon, GlobeIcon, XIcon } from "@/lib/kit/icons"
import { relativeTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { PreviewServer, ThreadId } from "@/protocol"
import { openPreviewInput, previewEnvironment, usePreviewServers } from "@/state/previewSession"
import { forgetRecent, recentsKeyForThread, useRecents } from "@/state/previewRecents"
import { usePreviewSurface } from "@/state/previewSurface"
import type { PreviewRecent } from "../../../../../../packages/kybern-client/src/previewRecents"
import { DockEmpty, DockHint, DockSectionLabel } from "../DockParts"

const MAX_SERVERS = 12
const MAX_RECENTS = 8
const SKELETON_DELAY_MS = 300

/** One shared minute clock, so a list of relative times costs one timer, not one per row. */
const minuteListeners = new Set<() => void>()
let minuteTimer: ReturnType<typeof setInterval> | undefined
let minuteNow = Date.now()
function subscribeMinute(listener: () => void) {
  minuteListeners.add(listener)
  if (!minuteTimer) {
    minuteTimer = setInterval(() => {
      minuteNow = Date.now()
      minuteListeners.forEach((fn) => fn())
    }, 60_000)
  }
  return () => {
    minuteListeners.delete(listener)
    if (minuteListeners.size === 0 && minuteTimer) {
      clearInterval(minuteTimer)
      minuteTimer = undefined
    }
  }
}
function useMinuteClock(): number {
  return useSyncExternalStore(subscribeMinute, () => minuteNow, () => minuteNow)
}

const ROW = "press flex h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-left outline-none hover:bg-[var(--sidebar-accent)] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"

function serverTitle(server: PreviewServer): string {
  if (server.title && server.title.length <= 48) return server.title
  return server.process_name ?? server.host
}
function folderTail(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  const parts = cwd.split("/").filter(Boolean)
  return parts.slice(-3).join("/")
}
function serverHost(server: PreviewServer): string {
  try { return new URL(server.url).host } catch { return `${server.host}:${server.port}` }
}

function sortServers(servers: PreviewServer[]): PreviewServer[] {
  return servers.slice().sort((a, b) => Number(!!b.in_project) - Number(!!a.in_project) || a.port - b.port)
}

function recentTitle(recent: PreviewRecent): string {
  if (recent.title) return recent.title
  if (recent.kind === "file") return recent.value.split("/").pop() ?? recent.value
  try { return new URL(recent.value).host } catch { return recent.value }
}
function recentLocation(recent: PreviewRecent): string {
  if (recent.kind === "file") {
    const parts = recent.value.split("/").filter(Boolean)
    parts.pop()
    return parts.length ? `…/${parts.slice(-2).join("/")}` : "/"
  }
  try {
    const url = new URL(recent.value)
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`
  } catch { return recent.value }
}

function Tile({ children, live }: { children: React.ReactNode; live?: boolean }) {
  return (
    <span className="relative flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-[var(--color-background-elevated-secondary)] text-muted-foreground">
      {children}
      {live && <span aria-hidden className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-emerald-500 ring-[1.5px] ring-[var(--color-background-button-secondary)]" />}
    </span>
  )
}

export function PreviewEmptyState({ threadId, active }: { threadId: ThreadId; active: boolean }) {
  const onScreen = usePreviewSurface((s) => s.windowOnScreen)
  // Scanning costs the daemon a few processes, so it runs only while this list can be seen.
  const { servers, failed } = usePreviewServers(threadId, active && onScreen)
  const environment = previewEnvironment()
  const recentsKey = recentsKeyForThread(threadId)
  const recents = useRecents(recentsKey).slice(0, MAX_RECENTS)
  const now = useMinuteClock()
  const [showAll, setShowAll] = useState(false)
  const [waited, setWaited] = useState(false)
  useEffect(() => {
    const id = window.setTimeout(() => setWaited(true), SKELETON_DELAY_MS)
    return () => window.clearTimeout(id)
  }, [])
  const skeleton = servers === null && waited

  const sorted = servers ? sortServers(servers) : []
  const shown = showAll ? sorted : sorted.slice(0, MAX_SERVERS)
  const hidden = sorted.length - shown.length
  const open = async (input: string, title?: string) => {
    const outcome = await openPreviewInput(threadId, input, { title })
    if (outcome.status === "error" && outcome.message) toast.error("Unable to open the page", { description: outcome.message })
  }
  const label = environment.remote ? `Servers on ${environment.name}` : "Local servers"

  if (servers !== null && sorted.length === 0 && recents.length === 0) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <DockEmpty icon={<GlobeIcon className="size-4" />} title="No local servers running" body="Start a dev server or enter a file path above. Servers appear here while they run." />
      </div>
    )
  }

  return (
    <ScrollArea className="h-full min-h-0 w-full">
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-5 px-3 py-4 font-system-ui" data-preview-empty>
        <section>
          <DockSectionLabel label={label} count={servers && sorted.length > 0 ? sorted.length : undefined} />
          {servers === null ? (
            skeleton && !failed ? (
              <div className="mx-3 flex flex-col gap-1 rounded-[10px] bg-[var(--color-background-button-secondary)] p-1" aria-hidden>
                {[0, 1, 2].map((i) => <div key={i} className="h-11 rounded-md bg-[var(--color-background-elevated-secondary)] opacity-60" />)}
              </div>
            ) : null
          ) : sorted.length === 0 ? (
            <DockHint>No local servers running. Start a dev server and it appears here.</DockHint>
          ) : (
            <>
              <ul className="mx-3 rounded-[10px] bg-[var(--color-background-button-secondary)] p-1">
                {shown.map((server) => {
                  const folder = folderTail(server.cwd)
                  const secondary = [server.process_name, folder].filter(Boolean).join(" · ")
                  return (
                    <li key={`${server.port}:${server.pid ?? ""}`}>
                      <button type="button" className={ROW} onClick={() => void open(server.url, server.title)} data-preview-server={server.port}>
                        <Tile live>
                          {server.favicon ? <img src={server.favicon} alt="" className="size-4 rounded-[3px]" /> : <GlobeIcon className="size-[13px]" />}
                        </Tile>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-[length:var(--app-font-size-ui,12px)] text-foreground/90">{serverTitle(server)}</span>
                          {secondary && <span className="truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70">{secondary}</span>}
                        </span>
                        <span className="shrink-0 text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums text-muted-foreground">{serverHost(server)}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
              {hidden > 0 && (
                <button type="button" onClick={() => setShowAll(true)} className="press mx-3 mt-1 flex h-7 items-center rounded-md px-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70 outline-hidden hover:bg-[var(--sidebar-accent)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">
                  Show {hidden} more
                </button>
              )}
              <DockHint>
                {environment.remote ? `Kybern forwards these through the connection to ${environment.name}.` : "Servers in this project come first. Updated every few seconds."}
              </DockHint>
            </>
          )}
        </section>

        {recents.length > 0 && (
          <section>
            <DockSectionLabel label="Recent" />
            <ul className="mx-3 rounded-[10px] bg-[var(--color-background-button-secondary)] p-1">
              {recents.map((recent) => {
                const title = recentTitle(recent)
                return (
                  <li key={`${recent.kind}:${recent.value}`} className="group/recent relative">
                    <button type="button" className={cn(ROW, "pr-9")} onClick={() => void open(recent.value, recent.title)}>
                      <Tile>{recent.kind === "file" ? <FileIcon className="size-[13px]" /> : <GlobeIcon className="size-[13px]" />}</Tile>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[length:var(--app-font-size-ui,12px)] text-foreground/90">{title}</span>
                        <span className="truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70">{recentLocation(recent)} · {ago(recent.at, now)}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${title} from recent`}
                      onClick={() => forgetRecent(recentsKey, recent.kind, recent.value)}
                      className="press absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity duration-150 outline-none hover:bg-[var(--color-background-elevated-secondary)] hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring group-focus-within/recent:opacity-100 group-hover/recent:opacity-100 pointer-coarse:opacity-100"
                    >
                      <XIcon className="size-3" />
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}
      </div>
    </ScrollArea>
  )
}

function ago(at: number, now: number): string {
  const text = relativeTime(new Date(at).toISOString(), now)
  return text === "now" ? "just now" : text.includes(" ") || /^[A-Z]/.test(text) ? text : `${text} ago`
}
