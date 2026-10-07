// Test-only account transport. Unexpected methods fail instead of reaching a daemon.
export * from "../src/state/rpc"
import { useStore } from "../src/state/store"
import type { Methods, ProviderKind } from "../src/protocol"
export const accountsFixture = {
  calls: [] as {method: string; params: unknown}[],
  failSave: false,
  failCreate: false,
  failSignIn: false,
  created: 0,
}
export const errorText = (problem: unknown) => problem instanceof Error ? problem.message : String(problem)
export async function refreshProviders() {}
async function call<K extends keyof Methods>(method: K, params: Methods[K][0]): Promise<Methods[K][1]> {
  accountsFixture.calls.push({method,params:structuredClone(params)})
  const result = await dispatch(method,params)
  return result as Methods[K][1]
}
async function dispatch(method: keyof Methods, input: unknown): Promise<unknown> {
  const settings = useStore.getState().settings!
  if (method === "settings.get") return settings
  if (method === "settings.update") {
    if (accountsFixture.failSave) throw new Error("Connection interrupted. Check your connection and try again.")
    const {settings: next} = input as Methods["settings.update"][0]
    useStore.getState().set({settings:next})
    return next
  }
  if (method === "providers.accounts.create") {
    if (accountsFixture.failCreate) throw new Error("This native account directory is unavailable.")
    const {kind,name,directory} = input as Methods["providers.accounts.create"][0]
    const instance = `created-${++accountsFixture.created}`
    const provider = settings.providers[kind] ?? {env:{}}
    useStore.getState().set({settings:{...settings,providers:{...settings.providers,[kind]:{...provider,accounts:{...provider.accounts,[instance]:{name,directory:directory ?? `/fixture/accounts/${instance}`}}}}}})
    return {kind,instance}
  }
  if (method === "providers.accounts.sign_in") {
    if (accountsFixture.failSignIn) throw new Error("The agent executable could not be opened.")
    return {id:"fixture-sign-in",thread_id:"",status:"running",cols:80,rows:24}
  }
  if (method === "terminals.close") return {}
  if (method === "threads.target.set") {
    const {target,inherit_account} = input as Methods["threads.target.set"][0]
    const provider = settings.providers[target.provider.kind as ProviderKind]
    const instance = inherit_account ? provider?.project_accounts?.["/fixture/project"] ?? provider?.default_account ?? "default" : target.provider.instance
    return {target:{...target,provider:{...target.provider,instance}},account_override:!inherit_account,effective_permission_mode:"supervised"}
  }
  throw new Error(`Unexpected account fixture RPC: ${method}`)
}
export function rpc() { return {call} }
