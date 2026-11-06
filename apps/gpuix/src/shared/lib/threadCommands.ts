import { nativeCommandSpecs, LOCAL_COMMAND_NAMES } from "../../../../../packages/kybern-client/src/nativeCommands.ts"
// The slash commands of an open thread, minus what each client does when one runs (icons and handlers): the
// order, names, hints and which ones exist. The desktop thread view and the GPUIX composer both build their
// list from this, so the two cannot drift.
import { PROVIDER_LABEL } from "@/lib/format"
import type { ProviderKind } from "@/protocol"

export type ThreadCommandId =
  | "resume" | "sessions" | "compact" | "new" | "reconnect" | "stop" | "activity" | "agents" | "attach"
  | "terminal" | "changes" | "files" | "environment" | "pr" | "archive" | "settings" | "usage"

/** Names a harness may also define; its own short name prefixes collisions so both stay reachable. */
export { LOCAL_COMMAND_NAMES }

export interface NativeThreadCommand { name: string; description: string }

export type ThreadCommandSpec =
  | { kind: "local"; id: ThreadCommandId; name: ThreadCommandId; hint: string }
  | { kind: "native"; name: string; label: string; invocation: string; hint: string }

export function threadCommandSpecs(options: { freeChat: boolean; canCompact: boolean; providerKind?: ProviderKind; nativeCommands: readonly NativeThreadCommand[] }): ThreadCommandSpec[] {
  const { freeChat, canCompact, providerKind, nativeCommands } = options
  const local = (id: ThreadCommandId, hint: string): ThreadCommandSpec => ({ kind: "local", id, name: id, hint })
  return [
    local("resume", "Continue a saved session"),
    local("sessions", "Browse saved sessions"),
    ...(canCompact ? [local("compact", "Compact context and keep conversation history")] : []),
    ...nativeCommandSpecs(nativeCommands, providerKind).map((command): ThreadCommandSpec => ({
      kind: "native",
      name: command.name,
      label: command.label,
      invocation: command.invocation,
      hint: `${PROVIDER_LABEL[providerKind ?? "codex"]} · ${command.description}`,
    })),
    local("new", freeChat ? "Start a new free chat" : "Start a new thread in this project"),
    local("reconnect", "Release the idle agent; resume history on your next message"),
    local("stop", "Interrupt the running turn"),
    local("activity", "Show agents and background processes"),
    local("agents", "Start and coordinate helper agents"),
    local("attach", "Attach files or images"),
    local("terminal", "Open a terminal in this thread"),
    ...(!freeChat ? [
      local("changes", "Show the changes panel"),
      local("files", "Browse the project files"),
      local("environment", "Show branch, commit and pull request controls"),
      local("pr", "Create a pull request from this thread"),
    ] : []),
    local("archive", "Archive this thread"),
    local("settings", "Open settings"),
    local("usage", "Review token usage and cost"),
  ]
}
