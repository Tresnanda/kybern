import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Composer } from "../Composer"
import { SubagentBar } from "./SubagentPage"
import { ComposerPanelStack, ComposerStackedPanel } from "@/components/kit/chat/ComposerStackedPanel"
import { Button } from "@/components/kit/button"
import { CheckIcon, CircleAlertIcon, ClockIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import type { ProviderStatus, SubagentMessage, Thread, UserMessage } from "@/protocol"
import { activeRuntime, errorText } from "@/state/rpc"
import { useStore } from "@/state/store"
import { subagentPhase } from "../../../../../packages/kybern-client/src/subagents.ts"

/** Native input keeps the regular editor, attachments, keyboard shortcuts and draft.
 * Only the dedicated child RPC can send it; no root queue/steering fallback exists. */
export function NativeSubagentComposer({ thread, providers, surfaceMode, isFocused }: { thread: Thread; providers: ProviderStatus[]; surfaceMode: "single" | "split"; isFocused: boolean }) {
  const [runtime] = useState(activeRuntime)
  const updates = useStore((state) => state.transcripts[thread.id]?.subagentMessages)
  const loaded = useStore((state) => state.transcripts[thread.id]?.loaded)
  const [saved, setSaved] = useState<SubagentMessage[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [forwarding, setForwarding] = useState<string | null>(null)
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null)
  const active = subagentPhase(thread.subagent!.status) === "working"
  useEffect(() => {
    let disposed = false
    void runtime.rpc().call("subagents.messages", { thread_id: thread.id }).then((messages) => {
      if (!disposed) { setSaved(messages); setLoadError(null) }
    }).catch((error) => { if (!disposed) setLoadError(errorText(error)) })
    return () => { disposed = true }
  }, [runtime, thread.id, thread.status, loaded])
  const messages = useMemo(() => {
    const merged = new Map(saved.map((message) => [message.id, message]))
    for (const message of updates ?? []) {
      const current = merged.get(message.id)
      if (!current || message.updated_at >= current.updated_at) merged.set(message.id, message)
    }
    return [...merged.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-100)
  }, [saved, updates])
  const visible = messages.filter((message) => message.status !== "delivered" || message === messages.at(-1)).slice(-20)
  const send = async (message: UserMessage) => {
    const fingerprint = JSON.stringify([thread.id, message])
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, id: crypto.randomUUID() }
    const result = await runtime.rpc().call("subagents.send", { thread_id: thread.id, id: attempt.current.id, message })
    setSaved((previous) => [...previous.filter((message) => message.id !== result.id), result].slice(-100))
    if (result.status === "failed") throw new Error(result.error ?? "Not delivered. Send the message to its parent.")
    attempt.current = null
  }
  const forward = async (message: SubagentMessage) => {
    setForwarding(message.id)
    try {
      const result = await runtime.rpc().call("subagents.send_to_parent", { thread_id: thread.id, message_id: message.id })
      setSaved((previous) => previous.map((record) => record.id === result.id ? result : record))
    } catch (error) { toast.error("Unable to send to parent", { description: errorText(error) }) }
    finally { setForwarding(null) }
  }
  return <Composer
    className="thread-composer"
    autoFocus={isFocused}
    draftKey={`thread:${thread.id}`}
    placeholder={active ? "Message this subagent" : "This subagent has finished"}
    disabled={!active}
    disabledReason="This subagent has finished. Send an undelivered message to its parent."
    onSend={send}
    mode={thread.permission_mode}
    onModeChange={() => {}}
    lockMode
    provider={thread.provider}
    model={thread.model}
    effort={thread.effort}
    providers={providers}
    projectId={thread.project_id}
    surfaceMode={surfaceMode}
    above={<ComposerPanelStack>
      <ComposerStackedPanel><SubagentBar thread={thread} embedded /></ComposerStackedPanel>
      <ComposerStackedPanel className="px-4 py-2 text-xs leading-[1.5] text-muted-foreground">
        <p>{active ? "Messages arrive at this subagent’s next tool call. Attachments are sent as file references." : "This subagent has finished. Send an undelivered message to its parent."}</p>
        {loadError && <p role="alert" className="mt-1 text-destructive">Unable to load delivery status: {loadError}</p>}
        {visible.length > 0 && <ul aria-label="Subagent message delivery" className="mt-2 flex max-h-40 flex-col gap-2 overflow-y-auto">
          {visible.map((message) => <li key={message.id} className="flex min-w-0 flex-wrap items-start gap-2" data-subagent-message-status={message.status}>
            {message.parent_queued || message.status === "pending" ? <ClockIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" /> : message.status === "delivered" ? <CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" /> : <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />}
            <div className="min-w-0 flex-1 basis-40 break-words">
              <p role="status" className={cn(message.status === "failed" && !message.parent_queued && "text-destructive")}>
                {message.parent_queued ? "Queued for parent" : message.status === "pending" ? "Waiting for next tool call" : message.status === "delivered" ? "Delivered to subagent" : message.error ?? "Not delivered — subagent finished"}
              </p>
              <p className="line-clamp-2" title={messagePreview(message)}>{messagePreview(message)}</p>
            </div>
            {message.status === "failed" && !message.parent_queued && <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" disabled={forwarding === message.id} onClick={() => void forward(message)}>{forwarding === message.id ? "Sending…" : "Send to parent"}</Button>}
          </li>)}
        </ul>}
      </ComposerStackedPanel>
    </ComposerPanelStack>}
  />
}

function messagePreview(message: SubagentMessage): string {
  return message.message.parts.map((part) => part.type === "text" ? part.text : part.type === "file_mention" ? `@${part.path}` : part.type === "attachment" ? part.name : part.type === "image" ? "Attached image" : "Reference").join(" ")
}
