/* eslint-disable @typescript-eslint/no-explicit-any */
export * from "./chat-collaboration-rpc"
import { rpc as chatRpc } from "./chat-collaboration-rpc"
import { useStore } from "../src/state/store"
import type { UsageRow } from "../src/protocol"
export const settingsFixture = { fail: false, empty: false, delay: 20, calls: [] as any[] }
const row = (key: string, n: number): UsageRow => ({ key, turns: n * 8, usage: { input_tokens: n * 72000, output_tokens: n * 18000, cache_read_tokens: n * 42000, cache_write_tokens: n * 2000 }, cost_usd: n * 1.47 })
export function rpc() { return { call: async (method: string, params: any): Promise<any> => {
  if (method === "usage.summary") {
    settingsFixture.calls.push(params)
    const { fail, empty, delay } = settingsFixture
    await new Promise(resolve => setTimeout(resolve, delay))
    if (fail) throw new Error("Connection interrupted. Check your connection and try again.")
    const rows = empty ? [] : params.group_by === "day" ? Array.from({ length: 30 }, (_, i) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 29 + i); return row(d.toISOString().slice(0, 10), (i * 7 % 11) + 1) }).filter(r => !params.since || r.key >= params.since.slice(0, 10)) : params.group_by === "model" ? [row("claude-sonnet-4-5", 6), row("gpt-5.6-sol", 4), row("(default)", 2)] : [row("claude-code", 6), row("codex", 4), row("omp", 2)]
    const total = row("total", 0)
    for (const r of rows) { total.turns += r.turns; total.cost_usd += r.cost_usd; for (const k of Object.keys(total.usage) as (keyof UsageRow["usage"])[]) total.usage[k] += r.usage[k] }
    return { rows, total }
  }
  if (method === "settings.update") { useStore.getState().set({ settings: params.settings }); return params.settings }
  if (method === "daemon.activity") return { live_sessions: 3, idle_sessions: 1, terminals: 2, connections: 1, queued_messages: 0 }
  if (method === "harness_updates.list") return { updates: [] }
  return chatRpc().call(method, params)
} } }
