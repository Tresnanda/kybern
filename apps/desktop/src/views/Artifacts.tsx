import { useEffect, useState } from "react"
import {
  artifactView,
  publishArtifactPrompt,
  type ArtifactView,
} from "../../../../packages/kybern-client/src/artifacts"
import { InputGroup, InputGroupInput } from "@/components/kit/input-group"
import { Button } from "@/components/kit/button"
import {
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
} from "@/components/kit/dialog"
import { Markdown } from "@/components/kybern/Markdown"
import { openExternal } from "@/lib/tauri"
import type { ArtifactTool, ThreadId } from "@/protocol"
import { activeRuntime, errorText } from "@/state/rpc"
import { useStore } from "@/state/store"

export function ArtifactsPane({
  threadId,
  active,
}: {
  threadId: ThreadId
  active: boolean
}) {
  const status = useStore((s) =>
    active ? s.threads[threadId]?.status : undefined
  )
  const provider = useStore((s) => s.threads[threadId]?.provider.kind)
  const [items, setItems] = useState<ArtifactTool[]>([])
  const [before, setBefore] = useState<number | null>(null)
  const [error, setError] = useState("")
  const [paging, setLoading] = useState(false)
  const [loadedKey, setLoadedKey] = useState("")
  const [refresh, setRefresh] = useState(0)
  const [path, setPath] = useState("")
  const [filePreview, setFilePreview] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [notice, setNotice] = useState("")
  const requestKey = `${threadId}:${status}:${refresh}:${active}`
  const loading = paging || loadedKey !== requestKey
  useEffect(() => {
    if (!active) return
    let alive = true
    const client = activeRuntime().rpc()
    void client
      .call("threads.artifacts.list", { thread_id: threadId })
      .then((result) => {
        if (alive) {
          setItems(result.artifacts)
          setBefore(result.next_before_seq)
          setError("")
        }
      })
      .catch((e) => {
        if (alive) setError(errorText(e))
      })
      .finally(() => {
        if (alive) setLoadedKey(requestKey)
      })
    return () => {
      alive = false
    }
  }, [active, threadId, status, refresh, requestKey])
  if (!active) return null
  async function publishFile() {
    setPublishing(true)
    setError("")
    setNotice("")
    try {
      const runtime = activeRuntime()
      const message = {
        parts: [
          {
            type: "text" as const,
            text: publishArtifactPrompt({ path: path.trim(), url: null }),
          },
        ],
      }
      if (status === "running" || status === "awaiting-approval") {
        await runtime.queueMessage(threadId, message)
        setNotice("Publication request queued.")
      } else {
        await runtime.sendMessage(threadId, message)
        setNotice("Claude is handling your publication request.")
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setPublishing(false)
    }
  }
  async function older() {
    if (before === null) return
    setLoading(true)
    try {
      const result = await activeRuntime()
        .rpc()
        .call("threads.artifacts.list", {
          thread_id: threadId,
          before_seq: before,
        })
      setItems((items) => [
        ...items,
        ...result.artifacts.filter(
          (item) => !items.some((existing) => existing.seq === item.seq)
        ),
      ])
      setBefore(result.next_before_seq)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }
  return (
    <div className="font-system-ui h-full w-full overflow-y-auto p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Artifacts</h2>
        <Button
          size="chip"
          variant="ghost"
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh
        </Button>
      </div>
      {error && (
        <p role="alert" className="mb-3 text-xs text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mb-3 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      {provider === "claude-code" && (
        <div className="mb-4 space-y-2">
          <InputGroup>
            <InputGroupInput
              aria-label="Artifact file path"
              placeholder="artifacts/dashboard.html"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          </InputGroup>
          <div className="flex flex-wrap gap-2">
            <Button
              size="chip"
              variant="subtle"
              disabled={!path.trim()}
              onClick={() => setFilePreview(true)}
            >
              Preview file
            </Button>
            <Button
              size="chip"
              variant="subtle"
              disabled={!path.trim() || publishing}
              onClick={() => void publishFile()}
            >
              Publish with Claude
            </Button>
          </div>
        </div>
      )}
      {filePreview && (
        <ArtifactPreview
          threadId={threadId}
          artifact={{
            id: "local",
            seq: 0,
            title: path.split("/").pop() || "Artifact",
            path: path.trim(),
            url: null,
            status: "completed",
          }}
          onClose={() => setFilePreview(false)}
        />
      )}
      {!items.length && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {loading
            ? "Loading artifacts…"
            : provider === "claude-code"
              ? "Ask Claude to create an artifact. Published pages and their local previews appear here."
              : "Claude Code publishes native artifacts. Open a Claude conversation to create one."}
        </p>
      )}
      <div className="space-y-3">
        {items.map((item) => (
          <ArtifactCard key={item.seq} tool={item} threadId={threadId} />
        ))}
      </div>
      {before !== null && (
        <Button
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => void older()}
          className="mt-3"
        >
          Load earlier artifacts
        </Button>
      )}
    </div>
  )
}

export function ArtifactCard({
  tool,
  threadId,
}: {
  tool: ArtifactTool
  threadId: ThreadId
}) {
  const artifact = artifactView(tool)
  const [preview, setPreview] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  if (!artifact) return null
  async function publish() {
    if (!artifact) return
    setBusy(true)
    setError("")
    try {
      const runtime = activeRuntime()
      const message = {
        parts: [
          { type: "text" as const, text: publishArtifactPrompt(artifact) },
        ],
      }
      const status = useStore.getState().threads[threadId]?.status
      if (status === "running" || status === "awaiting-approval")
        await runtime.queueMessage(threadId, message)
      else await runtime.sendMessage(threadId, message)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <article
      className="rounded-xl border border-border bg-[var(--color-background-elevated-secondary)] p-3"
      data-artifact-card
    >
      <h3 className="truncate text-sm font-medium">{artifact.title}</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        {artifact.status === "published"
          ? "Published on Claude"
          : artifact.status === "publishing"
            ? "Waiting for Claude to publish"
            : artifact.status === "failed"
              ? "Publication failed"
              : "Check Claude’s publication result"}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {artifact.path && (
          <Button variant="subtle" size="chip" onClick={() => setPreview(true)}>
            Preview
          </Button>
        )}
        {artifact.url && (
          <Button
            variant="subtle"
            size="chip"
            onClick={() =>
              void openExternal(artifact.url!).catch((e) =>
                setError(errorText(e))
              )
            }
          >
            Open in Claude
          </Button>
        )}
        {artifact.url && (
          <Button
            variant="ghost"
            size="chip"
            onClick={() =>
              void openExternal(artifact.url!).catch((e) =>
                setError(errorText(e))
              )
            }
          >
            Share and versions
          </Button>
        )}
        {artifact.path && artifact.status !== "publishing" && (
          <Button
            variant="ghost"
            size="chip"
            disabled={busy}
            onClick={() => void publish()}
          >
            {busy
              ? "Sending…"
              : artifact.url
                ? "Republish"
                : "Retry publishing"}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {preview && (
        <ArtifactPreview
          threadId={threadId}
          artifact={artifact}
          onClose={() => setPreview(false)}
        />
      )}
    </article>
  )
}

function ArtifactPreview({
  threadId,
  artifact,
  onClose,
}: {
  threadId: ThreadId
  artifact: ArtifactView
  onClose: () => void
}) {
  const [source, setSource] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [code, setCode] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void activeRuntime()
      .rpc()
      .call("threads.artifacts.read", {
        thread_id: threadId,
        path: artifact.path!,
      })
      .then((result) => {
        if (result.binary || result.truncated)
          throw new Error(
            "This file is binary or larger than 1 MB. Open the hosted artifact instead."
          )
        if (alive) setSource(result.content)
        if (!/\.(md|markdown)$/i.test(artifact.path ?? ""))
          return activeRuntime()
            .artifactPreviewUrl(threadId, artifact.path!)
            .then((url) => {
              if (alive) setPreviewUrl(url)
            })
      })
      .catch((e) => {
        if (alive) setError(errorText(e))
      })
    return () => {
      alive = false
    }
  }, [threadId, artifact.path])
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogPopup className="flex h-[min(800px,90dvh)] max-w-5xl flex-col gap-3">
        <DialogTitle>{artifact.title}</DialogTitle>
        <DialogDescription>
          Local preview. Open in Claude for live connectors, sharing, and
          version history.
        </DialogDescription>
        <div className="flex gap-2">
          <Button
            size="chip"
            variant="subtle"
            onClick={() => setCode((value) => !value)}
          >
            {code ? "Preview" : "Source"}
          </Button>
          {artifact.url && (
            <Button
              size="chip"
              variant="ghost"
              onClick={() => void openExternal(artifact.url!)}
            >
              Open in Claude
            </Button>
          )}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : source === null ? (
          <p className="text-sm text-muted-foreground">Loading preview…</p>
        ) : (
          <>
            {code && (
              <pre className="min-h-0 flex-1 overflow-auto text-xs whitespace-pre-wrap">
                {source}
              </pre>
            )}
            {/\.(md|markdown)$/i.test(artifact.path ?? "")
              ? !code && (
                  <div className="min-h-0 flex-1 overflow-auto">
                    <Markdown text={source} />
                  </div>
                )
              : previewUrl && (
                  <iframe
                    title={artifact.title}
                    sandbox="allow-scripts"
                    referrerPolicy="no-referrer"
                    src={previewUrl}
                    className={
                      code
                        ? "hidden"
                        : "min-h-0 w-full flex-1 rounded-lg border-0 bg-white"
                    }
                  />
                )}
          </>
        )}
      </DialogPopup>
    </Dialog>
  )
}
