/* eslint-disable @typescript-eslint/no-explicit-any */
export * from "./chat-collaboration-rpc"
import { rpc as chatRpc } from "./chat-collaboration-rpc"
import { useStore } from "../src/state/store"
import type { UsageRow } from "../src/protocol"
export const settingsFixture = { fail: false, empty: false, delay: 20, calls: [] as any[] }
const row = (key: string, n: number): UsageRow => ({ key, turns: n * 8, usage: { input_tokens: n * 72000, output_tokens: n * 18000, cache_read_tokens: n * 42000, cache_write_tokens: n * 2000 }, cost_usd: n * 1.47 })
let appNotes = [
  { bundle_id: "net.whatsapp.WhatsApp", app: "WhatsApp", updated_at: "2026-09-28T02:40:00Z", text: "- Set the compose box; background typing does not reach it.\n- To mention someone, set \"@Name\", press the suggested contact, then set the whole message starting with that full name." },
  { bundle_id: "com.apple.dt.Devices", app: "DeviceHub", updated_at: "2026-09-27T14:30:00Z", text: "- Tap with click_at on a screenshot; typing arrives as repeated keys." },
]
const computerStatus = { supported: true, enabled: true, installed: true, app_path: "/Applications/CuaDriver.app", version: "0.30.1", required_version: "0.30.1", signed: true, accessibility: "granted", screen_recording: "granted", ready: true, checks: [] }
export function rpc() { return { call: async (method: string, params: any): Promise<any> => {
  if (method === "computer.status") return computerStatus
  if (method === "computer.notes.list") return { notes: appNotes }
  if (method === "computer.notes.set") {
    appNotes = params.text.trim() ? appNotes.map(note => note.bundle_id === params.bundle_id ? { ...note, text: params.text.trim() } : note) : appNotes.filter(note => note.bundle_id !== params.bundle_id)
    return { notes: appNotes }
  }
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
