import { isTauri, resolveEndpoint, type EndpointInfo } from "./tauri"
import { KybernClient } from "@/protocol"
import {
  httpBase,
  normalizeDaemonUrl,
} from "../../../../packages/kybern-client/src/address"

/** How Kybern reaches a machine it set up over SSH; the tunnel is managed by the shell. */
export interface SshConfig {
  target: string
  port?: number
  remote_port: number
  local_port: number
  data_dir?: string
}
export interface EnvironmentProfile {
  id: string
  name: string
  url: string | null
  environment_id: string | null
  hostname: string | null
  local: boolean
  ssh?: SshConfig | null
}
export interface BootstrapRemote {
  id?: string
  name: string
  target: string
  data_dir?: string
}
export type BootstrapStep = "connect" | "install" | "start" | "pair"
export interface BootstrapProgress {
  step: BootstrapStep | "failed"
  state: "running" | "done" | "failed"
  detail?: string
}
export interface EnvironmentRegistry {
  selected_id: string
  environments: EnvironmentProfile[]
}
export interface EnvironmentEndpoint {
  profile: EnvironmentProfile
  endpoint: EndpointInfo
}
export interface SaveEnvironment {
  id?: string
  name: string
  url: string
  code?: string
  token?: string
  expected_environment_id?: string
}

const previewProfiles: EnvironmentProfile[] = []
const previewCredentials = new Map<string, string>()
let previewSelected = "local"

export async function listEnvironments(): Promise<EnvironmentRegistry> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core")
    return invoke("environments_list")
  }
  return {
    selected_id: previewSelected,
    environments: [
      {
        id: "local",
        name: "Development environment",
        url: null,
        environment_id: null,
        hostname: null,
        local: false,
      },
      ...previewProfiles,
    ],
  }
}

export async function openEnvironment(
  id: string
): Promise<EnvironmentEndpoint> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core")
    return invoke("environment_open", { id })
  }
  const profile = (await listEnvironments()).environments.find(
    (p) => p.id === id
  )
  if (!profile) throw new Error("Choose a saved environment")
  const ep =
    id === "local"
      ? await resolveEndpoint()
      : {
          url: profile.url!,
          token: previewCredentials.get(id) ?? "",
          http_base: httpBase(profile.url!),
          spawned: false,
        }
  if (!profile.environment_id) {
    const info = await verify(ep)
    profile.environment_id = info.environment_id
    profile.hostname = info.hostname
  }
  return { profile, endpoint: ep }
}

async function verify(ep: EndpointInfo) {
  const client = new KybernClient(ep)
  try {
    return await new Promise<NonNullable<KybernClient["info"]>>(
      (resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error("Connection timed out; check the address and network")
            ),
          15_000
        )
        client.onStatus((status, detail) => {
          if (status === "open" && client.info) {
            clearTimeout(timer)
            resolve(client.info)
          } else if (status === "failed" || status === "reconnecting") {
            clearTimeout(timer)
            reject(new Error(detail ?? "Unable to connect"))
          }
        })
        client.connect()
      }
    )
  } finally {
    client.close()
  }
}

export async function selectEnvironment(id: string): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("environment_select", { id })
  } else {
    previewSelected = id
  }
}

export async function saveEnvironment(
  input: SaveEnvironment
): Promise<EnvironmentProfile> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core")
    return invoke("environment_save", { input })
  }
  const url = normalizeDaemonUrl(input.url)
  let token =
    input.token?.trim() ||
    (input.id ? previewCredentials.get(input.id) : undefined)
  let pairedIdentity: string | undefined
  if (input.code) {
    const response = await fetch(`${httpBase(url)}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: input.code,
        device_name: "Kybern browser preview",
      }),
      redirect: "error",
    })
    if (!response.ok)
      throw new Error("Pairing failed; create a new code on that machine")
    const paired = (await response.json()) as {
      token: string
      environment_id: string
    }
    token = paired.token
    pairedIdentity = paired.environment_id
  }
  if (!token) throw new Error("Enter a pairing code or device token")
  const info = await verify({
    url,
    token,
    http_base: httpBase(url),
    spawned: false,
  })
  const existing = previewProfiles.find((p) => p.id === input.id)
  const expected =
    existing?.environment_id ?? input.expected_environment_id ?? pairedIdentity
  if (expected && expected !== info.environment_id)
    throw new Error(
      "This address belongs to a different environment; add it separately"
    )
  if (
    previewProfiles.some(
      (p) => p.environment_id === info.environment_id && p.id !== input.id
    )
  )
    throw new Error("This environment is already saved")
  const profile: EnvironmentProfile = {
    id: input.id ?? crypto.randomUUID(),
    name: input.name.trim(),
    url,
    environment_id: info.environment_id,
    hostname: info.hostname,
    local: false,
  }
  const index = previewProfiles.findIndex((p) => p.id === profile.id)
  if (index >= 0) previewProfiles.splice(index, 1, profile)
  else previewProfiles.push(profile)
  previewCredentials.set(profile.id, token)
  return profile
}

export async function removeEnvironment(id: string): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core")
    return invoke("environment_remove", { id })
  }
  if (id === "local")
    throw new Error("The development environment cannot be removed")
  const index = previewProfiles.findIndex((p) => p.id === id)
  if (index >= 0) previewProfiles.splice(index, 1)
  previewCredentials.delete(id)
  if (previewSelected === id) previewSelected = "local"
}

/** Set up a machine over SSH and save it. Progress arrives per step while the shell works. */
export async function bootstrapRemote(
  input: BootstrapRemote,
  onProgress: (progress: BootstrapProgress) => void
): Promise<EnvironmentProfile> {
  if (!isTauri())
    throw new Error("Adding a machine over SSH needs the desktop app")
  const { invoke } = await import("@tauri-apps/api/core")
  const { listen } = await import("@tauri-apps/api/event")
  const unlisten = await listen<BootstrapProgress>("remote-bootstrap", (event) =>
    onProgress(event.payload)
  )
  try {
    return await invoke("remote_bootstrap", { input })
  } finally {
    unlisten()
  }
}

/** Host aliases from ~/.ssh/config, offered as suggestions. */
export async function listSshHosts(): Promise<string[]> {
  if (!isTauri()) return []
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke("remote_ssh_hosts")
}
