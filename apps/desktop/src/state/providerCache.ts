import type { ProviderStatus } from "@/protocol"

const key = (environment: string) => `kybern.provider-catalog:${environment}`

export function readProviderCache(environment: string): ProviderStatus[] {
  try {
    const cached = JSON.parse(localStorage.getItem(key(environment)) ?? "null")
    if (!cached || Date.now() - cached.at > 86_400_000 || !Array.isArray(cached.providers)) return []
    return cached.providers.filter((p: ProviderStatus) => p && typeof p.kind === "string" && Array.isArray(p.models))
  } catch { return [] }
}

export function writeProviderCache(environment: string, providers: ProviderStatus[]) {
  try { localStorage.setItem(key(environment), JSON.stringify({ at: Date.now(), providers })) } catch { /* Storage may be full or disabled. */ }
}
