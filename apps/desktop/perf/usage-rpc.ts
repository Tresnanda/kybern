import type { ProviderLimits } from "../src/protocol"
export const pending: { resolve: (value: { providers: ProviderLimits[] }) => void; reject: (error: Error) => void }[] = []
export const errorText = (error: unknown) => String(error)
const client = {
  call(method: string) {
    if (method === "usage.limits") return new Promise((resolve, reject) => pending.push({ resolve, reject }))
    return Promise.resolve({ rows: [], total: { turns: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_usd: 0 } })
  },
  onNotification: () => () => {},
}
export const rpc = () => client
export const activeRuntime = () => ({ rpc: () => client })
