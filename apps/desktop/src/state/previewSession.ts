// Runtime state and navigation for the in-app preview, one session per thread. The store
// holds what the user sees in history (entries, viewport, floating); a session holds what
// is true right now: which document is loaded, whether it is loading, what the probe found.
// Sessions are never persisted.

import { create } from "zustand"
import { useEffect, useState } from "react"

import { onPreviewRelayWsFailed, previewRelayClose } from "@/lib/tauri"
import type { PreviewOpenRequestedNotification, PreviewProbeError, PreviewServer, ThreadId } from "@/protocol"
import { RpcCallError } from "@/protocol"
import {
  classifyPreviewInput,
  PREVIEW_REJECTED_MESSAGE,
  type PreviewContext,
} from "../../../../packages/kybern-client/src/previewTarget"
import { activeEnvironment } from "./environments"
import { forgetRecent, recentsKeyForThread, recordRecent } from "./previewRecents"
import { activeRuntime, errorText, PreviewNeedsPermissionError, PreviewRelayUnavailableError } from "./rpc"
import { useStore, type PreviewTarget, type WebPreview } from "./store"

export type PreviewLoad =
  | { phase: "idle" }
  | { phase: "resolving" }
  | { phase: "ready" }
  | { phase: "waiting"; error: "connection_refused" | "timed_out"; startedAt: number }
  | { phase: "blocked"; header: string; value: string }
  | { phase: "error"; error: PreviewProbeError | "unknown"; status?: number; message?: string }
  | { phase: "external" }
  | { phase: "not-found"; name: string }
  | { phase: "relay-failed" }

export type PreviewFrame = {
  url: string
  /** Increments on every Kybern-initiated navigation so the surface knows to navigate. */
  seq: number
  ticket?: string
  relayPort?: number
  /** `{daemon}/preview-files/{ticket}/` for file pages, used to reload at the bridge's path. */
  fileBase?: string
}

export type PreviewSession = {
  load: PreviewLoad
  frame: PreviewFrame | null
  loading: boolean
  /** Path the page reported through the bridge, relative to the file root. */
  bridgePath: string | null
  bridge: { back: number; forward: number }
  /** A server page navigated on its own, so the address is no longer exact. */
  navigatedAway: boolean
  /** The relay could not upgrade a WebSocket: live reload will not connect. */
  wsFailed: boolean
  wsNoticeDismissed: boolean
  /** Dock page unloaded after sitting hidden; it reloads when shown. */
  suspended: boolean
}

export const EMPTY_SESSION: PreviewSession = {
  load: { phase: "idle" },
  frame: null,
  loading: false,
  bridgePath: null,
  bridge: { back: 0, forward: 0 },
  navigatedAway: false,
  wsFailed: false,
  wsNoticeDismissed: false,
  suspended: false,
}

export const usePreviewSessions = create<{ sessions: Record<ThreadId, PreviewSession> }>(() => ({ sessions: {} }))

export function usePreviewSession(threadId: ThreadId): PreviewSession {
  return usePreviewSessions((s) => s.sessions[threadId]) ?? EMPTY_SESSION
}

export function patchSession(threadId: ThreadId, patch: Partial<PreviewSession>): void {
  usePreviewSessions.setState((s) => {
    const current = s.sessions[threadId] ?? EMPTY_SESSION
    return { sessions: { ...s.sessions, [threadId]: { ...current, ...patch } } }
  })
}

function session(threadId: ThreadId): PreviewSession {
  return usePreviewSessions.getState().sessions[threadId] ?? EMPTY_SESSION
}

/** Imperative handle a mounted surface registers so navigation can reach its iframe. */
export type FrameApi = {
  /** `contentWindow.location.replace(url)`, or `src` for the first load. */
  navigate: (url: string) => void
  post: (message: unknown) => void
}
const frameApis = new Map<ThreadId, FrameApi>()
export function registerFrameApi(threadId: ThreadId, api: FrameApi): () => void {
  frameApis.set(threadId, api)
  return () => { if (frameApis.get(threadId) === api) frameApis.delete(threadId) }
}

export function previewEnvironment(): { remote: boolean; name: string } {
  const environment = activeEnvironment()
  return { remote: !!environment && !environment.local, name: environment?.name ?? "this machine" }
}

export function previewContext(threadId: ThreadId): PreviewContext {
  const state = useStore.getState()
  const thread = state.threads[threadId]
  return { projectRoot: thread?.cwd, projectName: thread ? state.projects[thread.project_id]?.name : undefined }
}

export function currentWebPreview(threadId: ThreadId): WebPreview | undefined {
  const preview = useStore.getState().previews[threadId]
  return preview?.kind === "web" ? preview : undefined
}

// ── Opening ────────────────────────────────────────────────────────────────────────────────

export type OpenOutcome =
  | { status: "shown" | "queued" | "needs_permission" | "opens_in_browser" }
  | { status: "error"; message: string }

const SEARCH_URL = "https://www.google.com/search?q="
const prefetched = new Map<string, import("@/protocol").PreviewOpenResult>()
const prefetchKey = (threadId: ThreadId, path: string) => `${threadId}|${path}`

function errorCode(error: unknown): string {
  if (error instanceof RpcCallError) {
    const data = error.data
    if (typeof data === "string") return data
    if (data && typeof data === "object" && !Array.isArray(data)) {
      for (const key of ["code", "kind", "reason"]) {
        const value = (data as Record<string, unknown>)[key]
        if (typeof value === "string") return value
      }
    }
  }
  const message = errorText(error)
  if (/doesn't exist|does not exist|not found/i.test(message)) return "not_found"
  return ""
}

export function fileDisplay(path: string, root: string, inProject: boolean): string {
  return inProject && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

/** Classify an address, ask the daemon to normalize files, then show the page in the dock. */
export async function openPreviewInput(
  threadId: ThreadId,
  input: string,
  options: { requestedByAgent?: boolean; title?: string; focus?: boolean; allowFolder?: boolean } = {},
): Promise<OpenOutcome> {
  const store = useStore.getState()
  const target = classifyPreviewInput(input, previewContext(threadId))
  const common = { title: options.title, requestedByAgent: options.requestedByAgent, focus: options.focus, input }
  switch (target.kind) {
    case "empty":
      return { status: "error", message: "" }
    case "rejected":
      return { status: "error", message: PREVIEW_REJECTED_MESSAGE }
    case "search":
      store.openWebPreview(threadId, { kind: "external", url: `${SEARCH_URL}${encodeURIComponent(target.query)}`, query: target.query }, common)
      return { status: "opens_in_browser" }
    case "external":
      store.openWebPreview(threadId, { kind: "external", url: target.url }, common)
      return { status: "opens_in_browser" }
    case "server": {
      store.openWebPreview(threadId, { kind: "server", url: target.url }, common)
      recordRecent(recentsKeyForThread(threadId), { kind: "server", value: target.url, title: options.title, at: Date.now() })
      return outcomeFor(threadId, options)
    }
    case "file": {
      try {
        const result = await activeRuntime().rpc().call("previews.open", {
          thread_id: threadId,
          target: target.path,
          allow_folder: options.allowFolder || undefined,
        })
        if (result.needs_permission) {
          store.requestPreviewPermission(
            threadId,
            { input: target.path, folder: result.needs_permission.folder, grantable: result.needs_permission.grantable, title: options.title, agent: options.requestedByAgent },
            { focus: options.focus },
          )
          return { status: "needs_permission" }
        }
        const info = result.target
        if (info.kind === "file") {
          prefetched.set(prefetchKey(threadId, info.path), result)
          store.openWebPreview(threadId, { kind: "file", path: info.path, root: info.root, inProject: info.in_project, display: fileDisplay(info.path, info.root, info.in_project) }, common)
          recordRecent(recentsKeyForThread(threadId), { kind: "file", value: info.path, title: options.title, at: Date.now() })
        } else if (info.kind === "server") {
          store.openWebPreview(threadId, { kind: "server", url: info.url }, common)
          recordRecent(recentsKeyForThread(threadId), { kind: "server", value: info.url, title: options.title, at: Date.now() })
        } else {
          store.openWebPreview(threadId, { kind: "external", url: info.url }, common)
          return { status: "opens_in_browser" }
        }
        return outcomeFor(threadId, options)
      } catch (error) {
        return { status: "error", message: errorText(error) }
      }
    }
  }
}

function outcomeFor(threadId: ThreadId, options: { requestedByAgent?: boolean }): OpenOutcome {
  const preview = currentWebPreview(threadId)
  return { status: options.requestedByAgent && preview?.queued ? "queued" : "shown" }
}

/** The user confirmed the grant card. */
export async function allowPreviewFolder(threadId: ThreadId): Promise<OpenOutcome | undefined> {
  const pending = currentWebPreview(threadId)?.pending
  if (!pending) return undefined
  return openPreviewInput(threadId, pending.input, { allowFolder: true, title: pending.title, requestedByAgent: false, focus: true })
}

/** A `previews.open_requested` notification: show the page without moving keyboard focus. */
export async function openRequestedPreview(request: PreviewOpenRequestedNotification): Promise<void> {
  await openPreviewInput(request.thread_id, request.target, {
    requestedByAgent: request.requested_by_agent,
    title: request.title,
    focus: false,
  })
}

/** Open the page an agent queued while the user was navigating. */
export async function showQueuedPreview(threadId: ThreadId): Promise<void> {
  const queued = currentWebPreview(threadId)?.queued
  if (!queued) return
  useStore.getState().clearQueuedPreview(threadId)
  await openPreviewInput(threadId, queued.input, { title: queued.title, focus: true })
}

// ── Loading ────────────────────────────────────────────────────────────────────────────────

const runs = new Map<ThreadId, number>()

function entryOf(threadId: ThreadId) {
  const preview = currentWebPreview(threadId)
  return preview ? preview.entries[preview.index] : undefined
}

function frameFor(current: PreviewFrame | null, next: Omit<PreviewFrame, "seq">): PreviewFrame {
  return { ...next, seq: (current?.seq ?? 0) + 1 }
}

function closeFrameResources(frame: Pick<PreviewFrame, "ticket" | "relayPort"> | null | undefined): void {
  if (!frame) return
  if (frame.ticket) {
    try { void activeRuntime().closePreviewTicket(frame.ticket) } catch { /* disconnected: tickets expire on their own */ }
  }
  if (frame.relayPort !== undefined) void previewRelayClose(frame.relayPort)
}

/** Drop the live document and its ticket (thread switch, hidden too long, page closed). */
export function releasePreviewFrame(threadId: ThreadId, options: { suspend?: boolean } = {}): void {
  runs.set(threadId, (runs.get(threadId) ?? 0) + 1)
  const current = session(threadId)
  closeFrameResources(current.frame)
  patchSession(threadId, {
    frame: null,
    loading: false,
    load: { phase: "idle" },
    bridgePath: null,
    bridge: { back: 0, forward: 0 },
    suspended: !!options.suspend,
  })
}

const PROBE_FAILURES: PreviewProbeError[] = ["dns", "tls", "http_status", "not_http"]

/** Resolve the current entry to a document: mint a ticket, probe a server, or show a state. */
export async function loadPreviewEntry(threadId: ThreadId, reason: "navigate" | "retry" | "reload" = "navigate"): Promise<void> {
  const entry = entryOf(threadId)
  if (!entry) return
  const run = (runs.get(threadId) ?? 0) + 1
  runs.set(threadId, run)
  const stale = () => runs.get(threadId) !== run
  const target: PreviewTarget = entry.target
  const before = session(threadId)
  const waitingSince = before.load.phase === "waiting" ? before.load.startedAt : undefined
  patchSession(threadId, {
    load: reason === "retry" && before.load.phase === "waiting" ? before.load : { phase: "resolving" },
    loading: reason !== "retry",
    bridgePath: null,
    bridge: { back: 0, forward: 0 },
    navigatedAway: false,
    suspended: false,
    ...(reason === "retry" ? {} : { wsFailed: false, wsNoticeDismissed: false }),
  })

  if (target.kind === "external") {
    closeFrameResources(before.frame)
    patchSession(threadId, { frame: null, load: { phase: "external" }, loading: false })
    return
  }

  const runtime = activeRuntime()
  const fail = (load: PreviewLoad) => {
    if (stale()) return
    closeFrameResources(session(threadId).frame)
    patchSession(threadId, { frame: null, load, loading: false })
  }
  const commit = (next: Omit<PreviewFrame, "seq">) => {
    if (stale()) {
      closeFrameResources(next)
      return
    }
    const current = session(threadId)
    const frame = frameFor(current.frame, next)
    patchSession(threadId, { frame, load: { phase: "ready" }, loading: true })
    if (current.frame && (current.frame.ticket !== next.ticket || current.frame.relayPort !== next.relayPort)) closeFrameResources(current.frame)
  }

  try {
    if (target.kind === "file") {
      const key = prefetchKey(threadId, target.path)
      const result = prefetched.get(key)
      prefetched.delete(key)
      const frame = await runtime.previewFrameUrl(threadId, { kind: "file", path: target.path }, { prefetched: result })
      commit({ url: frame.url, ticket: frame.ticket, fileBase: /^(.*\/preview-files\/[^/]+\/)/.exec(frame.url)?.[1] })
      return
    }

    const { remote } = previewEnvironment()
    const relay = remote || !!target.relay
    // The probe runs on the daemon host, so it sees a remote machine's own loopback.
    if (!(relay && !remote)) {
      const probe = await runtime.rpc().call("previews.probe", { url: target.url })
      if (stale()) return
      if (probe.title) {
        useStore.getState().setPreviewTitle(threadId, probe.title)
        touchRecentTitle(threadId, target.url, probe.title)
      }
      if (!probe.reachable) {
        const error = probe.error
        if (error === "connection_refused" || error === "timed_out" || !error) {
          fail({ phase: "waiting", error: error === "timed_out" ? "timed_out" : "connection_refused", startedAt: waitingSince ?? Date.now() })
        } else if (PROBE_FAILURES.includes(error)) {
          fail({ phase: "error", error, status: probe.status })
        } else fail({ phase: "error", error: "unknown", status: probe.status })
        return
      }
      if (probe.blocked_by && !relay) {
        fail({ phase: "blocked", header: probe.blocked_by.header, value: probe.blocked_by.value })
        return
      }
    }
    const frame = await runtime.previewFrameUrl(threadId, { kind: "server", url: target.url }, { relay })
    commit(frame)
  } catch (error) {
    if (stale()) return
    if (error instanceof PreviewNeedsPermissionError) {
      closeFrameResources(session(threadId).frame)
      patchSession(threadId, { frame: null, load: { phase: "idle" }, loading: false })
      useStore.getState().requestPreviewPermission(threadId, { input: target.kind === "file" ? target.path : "", folder: error.request.folder, grantable: error.request.grantable })
      return
    }
    if (error instanceof PreviewRelayUnavailableError) {
      fail({ phase: "relay-failed" })
      return
    }
    if (target.kind === "file" && errorCode(error) === "not_found") {
      fail({ phase: "not-found", name: target.path.split("/").pop() ?? target.path })
      return
    }
    fail({ phase: "error", error: "unknown", message: errorText(error) })
  }
}

function touchRecentTitle(threadId: ThreadId, value: string, title: string): void {
  const key = recentsKeyForThread(threadId)
  const entry = entryOf(threadId)
  const kind = entry?.target.kind === "file" ? "file" : "server"
  forgetRecent(key, kind, value)
  recordRecent(key, { kind, value, title, at: Date.now() })
}

// ── From the surface ───────────────────────────────────────────────────────────────────────

/** The iframe finished a load. `own` is false for a navigation the page made by itself. */
export function frameLoaded(threadId: ThreadId, own: boolean): void {
  const current = session(threadId)
  patchSession(threadId, { loading: false, navigatedAway: current.navigatedAway || (!own && entryOf(threadId)?.target.kind === "server") })
}

export function bridgeNavStart(threadId: ThreadId): void {
  patchSession(threadId, { loading: true })
}

export function bridgeNav(threadId: ThreadId, message: { path: string; title: string; back: number; forward: number }): void {
  patchSession(threadId, { loading: false, bridgePath: message.path.replace(/^\/+/, ""), bridge: { back: message.back, forward: message.forward } })
  if (message.title) {
    useStore.getState().setPreviewTitle(threadId, message.title)
    const entry = entryOf(threadId)
    if (entry?.target.kind === "file") touchRecentTitle(threadId, entry.target.path, message.title)
  }
}

/** The 15 second ceiling: the bar ends silently. */
export function endLoading(threadId: ThreadId): void {
  if (session(threadId).loading) patchSession(threadId, { loading: false })
}

// ── Chrome actions ─────────────────────────────────────────────────────────────────────────

export function canGoBack(threadId: ThreadId): boolean {
  const preview = currentWebPreview(threadId)
  if (!preview) return false
  const entry = preview.entries[preview.index]
  if (entry?.target.kind === "file" && session(threadId).bridge.back > 0) return true
  return preview.index > 0
}

export function canGoForward(threadId: ThreadId): boolean {
  const preview = currentWebPreview(threadId)
  if (!preview) return false
  const entry = preview.entries[preview.index]
  if (entry?.target.kind === "file" && session(threadId).bridge.forward > 0) return true
  return preview.index < preview.entries.length - 1
}

/** Back or forward: in-page history for files (through the bridge), else Kybern's entries. */
export function goPreview(threadId: ThreadId, delta: -1 | 1): void {
  const preview = currentWebPreview(threadId)
  if (!preview) return
  const entry = preview.entries[preview.index]
  const bridge = session(threadId).bridge
  if (entry?.target.kind === "file" && (delta < 0 ? bridge.back : bridge.forward) > 0) {
    patchSession(threadId, { loading: true })
    frameApis.get(threadId)?.post({ type: "go", delta })
    return
  }
  const before = preview.index
  useStore.getState().navigatePreview(threadId, delta)
  if (currentWebPreview(threadId)?.index !== before) void loadPreviewEntry(threadId)
}

/** Reload the page. `fresh` mints a new ticket (files) or busts the cache (servers). */
export function reloadPreview(threadId: ThreadId, options: { fresh?: boolean } = {}): void {
  const current = session(threadId)
  const entry = entryOf(threadId)
  if (!entry) return
  const api = frameApis.get(threadId)
  const frame = current.frame
  if (!frame || !api || current.load.phase !== "ready") {
    void loadPreviewEntry(threadId, "reload")
    return
  }
  if (entry.target.kind === "file") {
    if (options.fresh) {
      void loadPreviewEntry(threadId, "reload")
      return
    }
    patchSession(threadId, { loading: true })
    api.navigate(frame.fileBase && current.bridgePath ? `${frame.fileBase}${current.bridgePath}` : frame.url)
    return
  }
  patchSession(threadId, { loading: true })
  if (options.fresh) {
    const url = new URL(frame.url)
    url.searchParams.set("__kybern_reload", String(Date.now()))
    api.navigate(url.href)
  } else api.navigate(frame.url)
}

export function stopPreviewLoading(threadId: ThreadId): void {
  patchSession(threadId, { loading: false })
}

/** Close the page: its document and ticket go, the tab shows the empty state. */
export function closePreviewPageAndRelease(threadId: ThreadId): void {
  releasePreviewFrame(threadId)
  useStore.getState().closePreviewPage(threadId)
}

// ── Relay events ───────────────────────────────────────────────────────────────────────────

let relayListener = false
export function installPreviewRelayListener(): void {
  if (relayListener) return
  relayListener = true
  void onPreviewRelayWsFailed((port) => {
    for (const [threadId, item] of Object.entries(usePreviewSessions.getState().sessions)) {
      if (item.frame?.relayPort === port) patchSession(threadId, { wsFailed: true })
    }
  })
}

// ── Local servers ──────────────────────────────────────────────────────────────────────────

const SERVER_POLL_MS = 3000

/** Poll `previews.servers.list` only while `enabled` (mounted, shown, window visible). */
export function usePreviewServers(threadId: ThreadId, enabled: boolean): { servers: PreviewServer[] | null; failed: boolean } {
  const [state, setState] = useState<{ servers: PreviewServer[] | null; failed: boolean }>({ servers: null, failed: false })
  useEffect(() => {
    if (!enabled) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const result = await activeRuntime().rpc().call("previews.servers.list", { thread_id: threadId })
        if (alive) setState({ servers: result.servers, failed: false })
      } catch {
        if (alive) setState((s) => ({ servers: s.servers, failed: true }))
      }
      if (alive) timer = setTimeout(poll, SERVER_POLL_MS)
    }
    void poll()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [enabled, threadId])
  return state
}
