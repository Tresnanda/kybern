// Fixture-only provider responses. Installation never reaches a real account.
import type {
  ArtifactTool,
  Integration,
  IntegrationChangeResult,
  IntegrationsCatalog,
} from "../src/protocol"
export * from "../src/state/rpc"
declare const __INTEGRATION_PREVIEW_URLS__: string[]
export const transport = {
  fail: false,
  sent: [] as { method: string; params: unknown }[],
  opened: [] as string[],
  previewIndex: 0,
}
const entries: Integration[] = Array.from({ length: 85 }, (_, i) => ({
  id: `plugin-${String(i).padStart(3, "0")}@fixture`,
  name: `Plugin ${String(i).padStart(3, "0")}`,
  kind: "plugin",
  description: "A provider-owned capability for your project.",
  scope: i ? null : "project",
  installed: i === 0,
  enabled: i === 0,
  status:
    i === 1 ? "Unavailable for this account" : i ? "Available" : "Enabled",
  actions: i === 1 ? [] : i ? ["install"] : ["disable", "uninstall"],
  connect_url: null,
  can_login: false,
}))
const connector: Integration = {
  id: "drive",
  name: "Drive",
  kind: "connector",
  description: "MCP server",
  scope: null,
  installed: true,
  enabled: true,
  status: "Sign in required",
  actions: [],
  can_login: true,
  connect_url: null,
}
const receipt: ArtifactTool = {
  seq: 15,
  at: "2026-09-09T00:00:00Z",
  call: {
    id: "artifact",
    name: "Artifact",
    input: { file_path: "demo.html", title: "Interactive dashboard" },
    parent_id: null,
  },
  output: { url: "https://claude.ai/public/artifacts/fixture" },
  is_error: false,
}
const notifications = new Map<string, Set<(params: unknown) => void>>()
const client = {
  status: "open",
  onStatus: () => () => {},
  onNotification(method: string, listener: (params: unknown) => void) {
    const listeners = notifications.get(method) ?? new Set()
    notifications.set(method, listeners)
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  async call(method: string, params: unknown): Promise<unknown> {
    transport.sent.push({ method, params })
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (transport.fail)
      throw new Error("Provider unavailable. Refresh to retry.")
    if (method === "integrations.list")
      return {
        items: entries.concat(connector),
        warnings: [],
      } satisfies IntegrationsCatalog
    if (method === "integrations.change") {
      const p = params as { id: string; action: string }
      const item = entries.find((i) => i.id === p.id)!
      item.installed = p.action !== "uninstall"
      item.enabled = p.action !== "disable" && item.installed
      item.actions = item.installed
        ? [item.enabled ? "disable" : "enable", "uninstall"]
        : ["install"]
      item.status = item.enabled
        ? "Enabled"
        : item.installed
          ? "Disabled"
          : "Available"
      return {
        message: "Plugin updated. Start a new session to apply it.",
        connections: [],
      } satisfies IntegrationChangeResult
    }
    if (method === "integrations.login")
      return {
        id: "oauth-terminal",
        thread_id: "fixture",
        title: "Connect Drive",
        alive: true,
      }
    if (method === "terminals.list")
      return {
        terminals: [
          {
            id: "oauth-terminal",
            thread_id: "fixture",
            title: "Connect Drive",
            cwd: "/fixture",
            alive: true,
            cols: 80,
            rows: 24,
          },
        ],
      }
    if (method === "terminals.subscribe") {
      setTimeout(
        () =>
          notifications
            .get("terminal.output")
            ?.forEach((listener) =>
              listener({
                terminal_id: "oauth-terminal",
                data: btoa(
                  "Open https://auth.example.test/authorize?state=fixture\r\nPaste redirect URL: "
                ),
              })
            ),
        20
      )
      return {}
    }
    if (
      ["terminals.unsubscribe", "terminals.resize", "terminals.input"].includes(
        method
      )
    )
      return {}
    if (method === "threads.artifacts.list")
      return { artifacts: [receipt], next_before_seq: null }
    if (method === "threads.artifacts.read")
      return {
        content: "<button id=counter>Click</button>",
        binary: false,
        truncated: false,
      }
    throw new Error(`Unexpected RPC ${method}`)
  },
}
export const rpc = () => client
export const activeRuntime = () => ({
  rpc,
  artifactPreviewUrl: async () =>
    __INTEGRATION_PREVIEW_URLS__[transport.previewIndex++]!,
  sendMessage: async (threadId: string, message: unknown) => {
    transport.sent.push({
      method: "threads.send",
      params: { threadId, message },
    })
  },
  queueMessage: async (threadId: string, message: unknown) => {
    transport.sent.push({ method: "queue.add", params: { threadId, message } })
  },
})
export async function openExternal(url: string) {
  transport.opened.push(url)
}
