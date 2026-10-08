// Test-only transport for the preview fixture: the real scratch daemon, a recording openExternal,
// and a relay stand-in that points straight at the daemon's proxy route (the Tauri relay is native).
import { KybernClient } from "../src/protocol/client"
import type { PreviewFolderRequest, PreviewOpenResult } from "../src/protocol"
declare const __PREVIEW_FIXTURE__: { url: string; http_base: string; token: string; thread_id: string; project: string; outside: string; ports: { vite: number; xfo: number; probe: number; closed: number; control: number }; realMockup: string }
export const fixture = __PREVIEW_FIXTURE__
const client = new KybernClient(fixture)
export async function connectFixture() {
  client.connect()
  const until = performance.now() + 10000
  while (client.status !== "open" && performance.now() < until) await new Promise(resolve => setTimeout(resolve, 20))
  if (client.status !== "open") throw new Error("Scratch daemon did not connect")
}
export const transport = { opened: [] as string[], listCalls: [] as number[], tickets: [] as string[], closed: [] as string[], rpcCalls: [] as string[] }
const httpBase = fixture.http_base
export class PreviewNeedsPermissionError extends Error {
  readonly request: PreviewFolderRequest
  constructor(request: PreviewFolderRequest) { super("Allow previewing files in this folder?"); this.name = "PreviewNeedsPermissionError"; this.request = request }
}
export class PreviewRelayUnavailableError extends Error {
  constructor() { super("Kybern can't forward this server through the current connection."); this.name = "PreviewRelayUnavailableError" }
}
const counted = {
  call: (method: string, params: unknown) => {
    transport.rpcCalls.push(method)
    if (method === "previews.servers.list") transport.listCalls.push(performance.now())
    return (client.call as (m: string, p: unknown) => Promise<unknown>)(method, params)
  },
}
const rpc = () => ({ call: counted.call as KybernClient["call"] })
export const activeRuntime = () => ({
  rpc,
  previewFrameUrl: async (threadId: string, target: { kind: "file"; path: string } | { kind: "server"; url: string }, options: { relay?: boolean; allowFolder?: boolean; prefetched?: PreviewOpenResult } = {}) => {
    if (target.kind === "server" && !options.relay) return { url: target.url }
    const result = options.prefetched ?? await client.call("previews.open", { thread_id: threadId, target: target.kind === "file" ? target.path : target.url, allow_folder: options.allowFolder || undefined, proxy: target.kind === "server" ? true : undefined })
    if (result.needs_permission) throw new PreviewNeedsPermissionError(result.needs_permission)
    if (!result.ticket) throw new Error("The preview could not start. Try again.")
    transport.tickets.push(result.ticket)
    if (target.kind === "file") return { url: `${httpBase}${result.path}`, ticket: result.ticket }
    const relay = await previewRelayOpen(`${httpBase}/preview-proxy/${encodeURIComponent(result.ticket)}`)
    const upstream = new URL(target.url)
    return { url: `${relay}${upstream.pathname}${upstream.search}${upstream.hash}`, ticket: result.ticket, relayPort: Number(new URL(relay!).port) }
  },
  closePreviewTicket: async (ticket: string) => { transport.closed.push(ticket); try { await client.call("previews.close", { ticket }) } catch { /* expired */ } },
  visualFrameUrl: async () => { throw new Error("not used") },
})
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
export const openExternal = async (url: string) => { transport.opened.push(url) }
export const saveHtmlFile = async () => true
export const previewRelayOpen = async (upstream: string): Promise<string | null> => upstream
export const previewRelayClose = async () => {}
export const onPreviewRelayWsFailed = async () => () => {}
export const client_ = client
export const closeFixture = () => client.close()
