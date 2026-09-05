import { create } from "zustand"
import { reloadOnHotUpdate } from "@/lib/hot"
import {
  listEnvironments,
  openEnvironment,
  selectEnvironment,
  removeEnvironment,
  saveEnvironment,
  type EnvironmentProfile,
  type SaveEnvironment,
} from "@/lib/environments"
import {
  activateEnvironmentStore,
  forgetEnvironmentStore,
  useStore,
} from "./store"
import {
  createEnvironmentRuntime,
  setEnvironmentRuntime,
  type EnvironmentRuntime,
} from "./rpc"

interface EnvironmentsState {
  profiles: EnvironmentProfile[]
  selectedId: string
  /** Remount every environment surface, including local component state. */
  epoch: number
  switching: boolean
  error: string | null
}
export const useEnvironments = create<EnvironmentsState>(() => ({
  profiles: [],
  selectedId: "local",
  epoch: 0,
  switching: true,
  error: null,
}))
let runtime: EnvironmentRuntime | null = null
let sequence = 0
let booted = false

export async function bootEnvironments() {
  try {
    const registry = await listEnvironments()
    useEnvironments.setState({ profiles: registry.environments })
    await switchEnvironment(
      booted ? useEnvironments.getState().selectedId : registry.selected_id
    )
    booted = true
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    useEnvironments.setState({ switching: false, error: detail })
    useStore.getState().set({ connection: { state: "failed", detail } })
  }
}

export async function switchEnvironment(id: string) {
  const attempt = ++sequence
  const profile = useEnvironments.getState().profiles.find((p) => p.id === id)
  if (!profile) throw new Error("Choose a saved environment")
  runtime?.disconnect()
  runtime = null
  setEnvironmentRuntime(null)
  const pendingStore = activateEnvironmentStore(
    profile.environment_id ?? `connecting:${id}`
  )
  pendingStore
    .getState()
    .set({
      connection: { state: "connecting" },
      paletteOpen: false,
      settingsOpen: false,
      handoffThread: null,
    })
  useEnvironments.setState((state) => ({
    selectedId: id,
    epoch: state.epoch + 1,
    switching: true,
    error: null,
  }))
  try {
    await selectEnvironment(id)
    if (attempt !== sequence) return
    const { profile: resolved, endpoint } = await openEnvironment(id)
    if (attempt !== sequence) return
    if (!resolved.environment_id)
      throw new Error("Unable to verify the environment identity")
    const store = activateEnvironmentStore(resolved.environment_id)
    store
      .getState()
      .set({
        connection: { state: "connecting" },
        paletteOpen: false,
        settingsOpen: false,
        handoffThread: null,
      })
    runtime = createEnvironmentRuntime(store)
    setEnvironmentRuntime(runtime)
    useEnvironments.setState((state) => ({
      profiles: state.profiles.map((p) => (p.id === id ? resolved : p)),
      epoch: state.epoch + 1,
      switching: false,
    }))
    runtime.connect(endpoint)
  } catch (error) {
    if (attempt !== sequence) return
    const detail = error instanceof Error ? error.message : String(error)
    useEnvironments.setState({ switching: false, error: detail })
    useStore.getState().set({ connection: { state: "failed", detail } })
  }
}

export async function saveAndConnectEnvironment(input: SaveEnvironment) {
  const profile = await saveEnvironment(input)
  const registry = await listEnvironments()
  useEnvironments.setState({ profiles: registry.environments })
  await switchEnvironment(profile.id)
}

export async function forgetEnvironment(id: string) {
  const profile = useEnvironments.getState().profiles.find((p) => p.id === id)
  await removeEnvironment(id)
  if (profile?.environment_id) forgetEnvironmentStore(profile.environment_id)
  const registry = await listEnvironments()
  useEnvironments.setState({ profiles: registry.environments })
  if (useEnvironments.getState().selectedId === id)
    await switchEnvironment("local")
}

export function activeEnvironment() {
  const state = useEnvironments.getState()
  return state.profiles.find((p) => p.id === state.selectedId)
}

function wake() {
  if (document.visibilityState === "visible")
    void runtime?.rpc().checkConnection()
}
if (typeof window !== "undefined") {
  window.addEventListener("online", wake)
  document.addEventListener("visibilitychange", wake)
}
reloadOnHotUpdate(import.meta.hot)
