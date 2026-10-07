// Test-only transport: actual scratch-daemon source and sandbox tickets.
import { KybernClient } from "../src/protocol/client"
import type { HtmlVisual } from "../src/protocol"
declare const __VISUAL_FIXTURE__: { url: string; http_base: string; token: string; thread_id: string; visual: HtmlVisual }
export const fixture = __VISUAL_FIXTURE__
const client = new KybernClient(fixture)
export async function connectFixture() {
  client.connect()
  const until = performance.now() + 10000
  while (client.status !== "open" && performance.now() < until) await new Promise(resolve => setTimeout(resolve,20))
  if (client.status !== "open") throw new Error("Scratch daemon did not connect")
}
export const transport = { frameLoads: 0, opened: [] as string[], saved: [] as {name:string;html:string}[] }
export const activeRuntime = () => ({
  rpc: () => client,
  visualFrameUrl: async (threadId: string, visualId: string) => {
    const {ticket} = await client.call("threads.visuals.frame",{thread_id:threadId,visual_id:visualId})
    transport.frameLoads++
    return {url:`${fixture.http_base}/visual-frame/${ticket}`,ticket}
  },
})
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
export const openExternal = async (url: string) => { transport.opened.push(url) }
export const closeFixture = () => client.close()

export const saveHtmlFile = async (name:string,html:string) => { transport.saved.push({name,html}); return true }
