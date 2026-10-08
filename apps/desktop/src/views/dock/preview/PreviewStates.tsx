import { useEffect, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"

import { Button } from "@/components/kit/button"
import { Spinner } from "@/components/kybern/bits"
import { FolderIcon, FolderOpenIcon, GlobeIcon, InfoIcon, RefreshCwIcon, ShieldIcon, TriangleAlertIcon, XIcon } from "@/lib/kit/icons"
import { openExternal } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import type { ThreadId } from "@/protocol"
import {
  allowPreviewFolder,
  loadPreviewEntry,
  patchSession,
  previewEnvironment,
  reloadPreview,
  showQueuedPreview,
  type PreviewSession,
} from "@/state/previewSession"
import { useStore, type PendingPermission, type WebPreview } from "@/state/store"

const WAIT_RETRY_MS = 2000
const WAIT_LIMIT_MS = 60_000

function StateShell({ icon, title, body, children, className }: { icon: ReactNode; title: string; body?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div data-preview-state className={cn("absolute inset-0 z-[1] flex items-center justify-center overflow-y-auto bg-[var(--color-background-surface)] p-6 font-system-ui", className)}>
      <div className="flex w-full max-w-[340px] flex-col items-center text-center">
        <span className="mb-3 flex size-8 items-center justify-center rounded-lg bg-[var(--color-background-elevated-secondary)] text-muted-foreground/80">{icon}</span>
        <h2 className="text-[13px] leading-[18px] font-medium text-foreground/90 text-balance break-words">{title}</h2>
        {body && <p className="mt-1 text-[12px] leading-[18px] text-muted-foreground text-pretty">{body}</p>}
        {children}
      </div>
    </div>
  )
}

function headerName(header: string): string {
  return header.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("-")
}

function targetHost(url: string): string {
  try { return new URL(url).host } catch { return url }
}

/** The state that replaces the page, or null while a page loads or shows. */
export function PreviewStateView({ threadId, preview, session, active, onShowFolder }: { threadId: ThreadId; preview: WebPreview; session: PreviewSession; active: boolean; onShowFolder: () => void }) {
  if (preview.pending) return <PermissionCard threadId={threadId} pending={preview.pending} active={active} />
  const entry = preview.entries[preview.index]
  if (!entry) return null
  const target = entry.target
  const load = session.load
  switch (load.phase) {
    case "waiting":
      return target.kind === "server" ? <WaitingState threadId={threadId} url={target.url} startedAt={load.startedAt} error={load.error} active={active} /> : null
    case "blocked":
      return target.kind === "server" ? <BlockedState threadId={threadId} url={target.url} header={load.header} value={load.value} /> : null
    case "error":
      return target.kind === "server" ? <ErrorState threadId={threadId} url={target.url} error={load.error} status={load.status} message={load.message} /> : <GenericError message={load.message} threadId={threadId} />
    case "external":
      return target.kind === "external" ? <ExternalState url={target.url} query={target.query} /> : null
    case "not-found":
      return <NotFoundState name={load.name} inProject={target.kind === "file" && !!target.inProject} onShowFolder={onShowFolder} />
    case "relay-failed":
      return target.kind === "server" ? <RelayFailedState url={target.url} /> : null
    default:
      return null
  }
}

function WaitingState({ threadId, url, startedAt, error, active }: { threadId: ThreadId; url: string; startedAt: number; error: "connection_refused" | "timed_out"; active: boolean }) {
  const u = new URL(url)
  const port = u.port || (u.protocol === "https:" ? "443" : "80")
  const host = u.host
  const [now, setNow] = useState(() => Date.now())
  const stopped = now - startedAt >= WAIT_LIMIT_MS
  // Retries only while this pane is shown and the window is on screen.
  useEffect(() => {
    if (!active || stopped) return
    const id = window.setInterval(() => {
      const time = Date.now()
      setNow(time)
      if (time - startedAt < WAIT_LIMIT_MS && !document.hidden) void loadPreviewEntry(threadId, "retry")
    }, WAIT_RETRY_MS)
    return () => window.clearInterval(id)
  }, [active, stopped, startedAt, threadId])
  const retry = () => {
    patchSession(threadId, { load: { phase: "waiting", error, startedAt: Date.now() } })
    setNow(Date.now())
    void loadPreviewEntry(threadId, "retry")
  }
  const hostname = u.hostname === "localhost" ? "127.0.0.1" : u.hostname.replace(/^\[|\]$/g, "")
  return (
    <StateShell
      icon={<TriangleAlertIcon className="size-4 text-[var(--warning)]" />}
      title={`Can't reach ${host}`}
      body={error === "timed_out" ? "The server didn't answer within 1.5 seconds." : `Nothing is answering on port ${port}. Start the dev server and the page opens here when it's ready.`}
    >
      <p role="status" className="mt-3 flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
        {!stopped && <Spinner size={12} />}
        {stopped ? "Stopped waiting." : "Waiting for the server…"}
      </p>
      <p className="mt-1 font-mono text-[11px] leading-4 text-muted-foreground/70">{error === "timed_out" ? "ETIMEDOUT" : "ECONNREFUSED"} {hostname}:{port}</p>
      <Button size="sm" variant="subtle" className="mt-3" onClick={retry}>
        <RefreshCwIcon className="size-3.5" />
        {stopped ? "Try again" : "Try now"}
      </Button>
    </StateShell>
  )
}

function BlockedState({ threadId, url, header, value }: { threadId: ThreadId; url: string; header: string; value: string }) {
  const host = targetHost(url)
  const local = !previewEnvironment().remote
  return (
    <StateShell
      icon={<ShieldIcon className="size-4" />}
      title={`${host} can't be shown in a panel`}
      body={`The page sends ${headerName(header)}: ${value}, so browsers only show it as its own tab.`}
    >
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        <Button size="sm" onClick={() => void openExternal(url)}>Open in browser</Button>
        {local && <Button size="sm" variant="subtle" onClick={() => useStore.getState().setPreviewRelay(threadId, true)}>Preview through Kybern</Button>}
      </div>
      {local && <p className="mt-2 text-[11px] leading-4 text-muted-foreground/70 text-pretty">Kybern relays the page and removes the frame restriction. Cookies are kept separate from your browser.</p>}
    </StateShell>
  )
}

function ErrorState({ threadId, url, error, status, message }: { threadId: ThreadId; url: string; error: string; status?: number; message?: string }) {
  const host = targetHost(url)
  const body =
    error === "dns" ? "The address couldn't be found."
    : error === "tls" ? "The certificate isn't trusted."
    : error === "http_status" ? `The server returned ${status ?? "an error"}.`
    : error === "not_http" ? "This port doesn't serve web pages."
    : message ?? "The page didn't load. Try again."
  return (
    <StateShell icon={<TriangleAlertIcon className="size-4 text-[var(--warning)]" />} title={`Can't open ${host}`} body={body}>
      <div className="mt-3 flex items-center justify-center gap-2">
        {error === "tls" && <Button size="sm" onClick={() => void openExternal(url)}>Open in browser</Button>}
        <Button size="sm" variant="subtle" onClick={() => void loadPreviewEntry(threadId)}>
          <RefreshCwIcon className="size-3.5" />
          Try again
        </Button>
      </div>
    </StateShell>
  )
}

function GenericError({ threadId, message }: { threadId: ThreadId; message?: string }) {
  return (
    <StateShell icon={<TriangleAlertIcon className="size-4 text-[var(--warning)]" />} title="Can't open this page" body={message ?? "The page didn't load. Try again."}>
      <Button size="sm" variant="subtle" className="mt-3" onClick={() => void loadPreviewEntry(threadId)}>
        <RefreshCwIcon className="size-3.5" />
        Try again
      </Button>
    </StateShell>
  )
}

function ExternalState({ url, query }: { url: string; query?: string }) {
  const host = targetHost(url)
  return (
    <StateShell
      icon={<GlobeIcon className="size-4" />}
      title={query ? `Searching for “${query}” opens in your browser` : `${host} opens in your browser`}
      body="Kybern previews local files and dev servers. Other websites open in your default browser."
    >
      <Button size="sm" className="mt-3" onClick={() => void openExternal(url)}>{query ? "Search in browser" : "Open in browser"}</Button>
    </StateShell>
  )
}

function NotFoundState({ name, inProject, onShowFolder }: { name: string; inProject: boolean; onShowFolder: () => void }) {
  return (
    <StateShell icon={<FolderIcon className="size-4" />} title={`${name} isn't there anymore`} body="It may have been moved or deleted.">
      {inProject && <Button size="sm" variant="subtle" className="mt-3" onClick={onShowFolder}>Show folder in Explorer</Button>}
    </StateShell>
  )
}

function RelayFailedState({ url }: { url: string }) {
  const env = previewEnvironment().name
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); toast("Address copied") } catch { toast.error("Unable to copy the address", { description: "Select the address and copy it instead." }) }
  }
  return (
    <StateShell icon={<GlobeIcon className="size-4" />} title={`Open this page on ${env}`} body="Kybern can't forward this server through the current connection.">
      <div className="mt-3 flex items-center justify-center gap-2">
        <Button size="sm" variant="subtle" onClick={() => void copy()}>Copy address</Button>
        <Button size="sm" onClick={() => void openExternal(url)}>Open in browser</Button>
      </div>
    </StateShell>
  )
}

function PermissionCard({ threadId, pending, active }: { threadId: ThreadId; pending: PendingPermission; active: boolean }) {
  const allowRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const name = pending.input.split("/").pop() || pending.input
  // Focus the primary action when the card shows in the active pane. A request from an agent never steals focus.
  useEffect(() => {
    if (active && !pending.agent) allowRef.current?.focus({ preventScroll: true })
  }, [active, pending.agent])
  const allow = async () => {
    setBusy(true)
    const outcome = await allowPreviewFolder(threadId)
    setBusy(false)
    if (outcome?.status === "error") toast.error("Unable to open the page", { description: outcome.message })
  }
  return (
    <div data-preview-state="permission" className="absolute inset-0 z-[1] flex items-center justify-center overflow-y-auto bg-[var(--color-background-surface)] p-6 font-system-ui">
      <div role="group" aria-labelledby="preview-permission-title" className="w-full max-w-[360px] rounded-[12px] bg-[var(--color-background-elevated-primary-opaque)] p-4 shadow-[0_0_0_1px_var(--color-border),0_8px_24px_-8px_rgb(0_0_0/0.18)]">
        {pending.agent && <p className="mb-2 text-[11px] leading-4 text-muted-foreground">The agent wants to open {name}</p>}
        <span className="mb-3 flex size-8 items-center justify-center rounded-lg bg-[var(--color-background-elevated-secondary)] text-muted-foreground/80"><FolderIcon className="size-4" /></span>
        <h2 id="preview-permission-title" className="text-[13px] leading-[18px] font-medium text-foreground/90">
          {pending.grantable ? "Allow previewing files in this folder?" : "Kybern can't preview files from this folder"}
        </h2>
        <p className="mt-2 rounded-md bg-[var(--color-background-button-secondary)] px-2 py-1.5 font-mono text-[11px] leading-4 break-all text-foreground/85" data-preview-folder>{pending.folder}</p>
        <p className="mt-2 text-[12px] leading-[18px] text-muted-foreground text-pretty">
          {pending.grantable
            ? "Pages in this folder can run scripts in an isolated preview. They can't reach your other files or Kybern. Kybern remembers this folder."
            : "Move the file into your project or a subfolder."}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => useStore.getState().clearPreviewPermission(threadId)}>{pending.grantable ? "Cancel" : "Close"}</Button>
          {pending.grantable && (
            <Button ref={allowRef} size="sm" disabled={busy} onClick={() => void allow()}>
              <FolderOpenIcon className="size-3.5" />
              Allow folder
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

const STRIP = "chat-surface-divider flex h-7 shrink-0 items-center gap-2 px-3 font-system-ui text-[11px] leading-4 text-muted-foreground"

/** Thin strips between the chrome row and the page: address errors, live reload, queued agent page, reconnecting. */
export function PreviewNotices({ threadId, preview, session, addressError }: { threadId: ThreadId; preview: WebPreview | undefined; session: PreviewSession; addressError: string | null }) {
  const connected = useStore((s) => s.connection.state === "open")
  const environment = previewEnvironment()
  const entry = preview?.entries[preview.index]
  const relayed = entry?.target.kind === "server" && (environment.remote || !!entry.target.relay)
  return (
    <>
      {addressError && (
        <p role="alert" className={cn(STRIP, "text-destructive")}>
          <InfoIcon aria-hidden className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{addressError}</span>
        </p>
      )}
      {preview?.queued && (
        <p className={STRIP} role="status">
          <span className="min-w-0 flex-1 truncate">New page from agent</span>
          <button type="button" onClick={() => void showQueuedPreview(threadId)} className="press shrink-0 rounded-sm px-1 text-foreground/85 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">Show</button>
        </p>
      )}
      {session.wsFailed && !session.wsNoticeDismissed && relayed && (
        <p className={STRIP}>
          <InfoIcon aria-hidden className="size-3 shrink-0" />
          <span className="min-w-0 truncate">Live reload isn't connected through {environment.name}. Reload to see changes.</span>
          <button type="button" onClick={() => reloadPreview(threadId)} className="press shrink-0 rounded-sm px-1 text-foreground/85 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">Reload</button>
          <button type="button" aria-label="Dismiss" onClick={() => patchSession(threadId, { wsNoticeDismissed: true })} className="press -mr-1 flex size-5 shrink-0 items-center justify-center rounded-sm outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"><XIcon className="size-3" /></button>
        </p>
      )}
      {!connected && environment.remote && entry && (entry.target.kind === "file" || relayed) && (
        <p className={STRIP} role="status">
          <Spinner size={12} />
          <span className="min-w-0 truncate">Reconnecting to {environment.name}…</span>
        </p>
      )}
    </>
  )
}
