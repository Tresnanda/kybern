import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { IconButton } from "@/components/kit/icon-button"
import { Menu, MenuCheckboxItem, MenuGroup, MenuItem, MenuSeparator, MenuTrigger } from "@/components/kit/menu"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { IconSwap } from "@/components/kybern/motion"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CopyIcon,
  DeviceMobileIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  FileIcon,
  FolderIcon,
  GlobeIcon,
  PictureInPictureIcon,
  RefreshCwIcon,
  ShieldIcon,
  TriangleAlertIcon,
  XIcon,
} from "@/lib/kit/icons"
import { openExternal } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import type { ThreadId } from "@/protocol"
import {
  closePreviewPageAndRelease,
  goPreview,
  openPreviewInput,
  previewEnvironment,
  reloadPreview,
  stopPreviewLoading,
  type PreviewSession,
} from "@/state/previewSession"
import { useStore, type WebPreview } from "@/state/store"
import { startingDeviceViewport } from "./deviceViewport"
import { currentAddress } from "./previewAddress"
import { PreviewAction, PreviewActionGroup, PreviewToggle } from "../PreviewPanel"

type Entry = WebPreview["entries"][number]

export function PreviewChromeRow({
  threadId,
  preview,
  session,
  active,
  narrow,
  onAddressError,
}: {
  threadId: ThreadId
  preview: WebPreview | undefined
  session: PreviewSession
  active: boolean
  /** Pane narrower than 360px: Forward hides and the device and float toggles move into More. */
  narrow: boolean
  onAddressError: (message: string | null) => void
}) {
  const entry: Entry | undefined = preview?.entries[preview.index]
  const target = entry?.target
  const environment = previewEnvironment()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const address = entry ? currentAddress(threadId, entry.target, session.bridgePath) : null
  const device = preview?.viewport.mode === "device"
  const floating = !!preview?.floating
  const hasPage = !!entry
  const loading = session.loading
  const relay = target?.kind === "server" && !!target.relay
  const localServer = target?.kind === "server" && !environment.remote
  const projectId = useStore((s) => s.threads[threadId]?.project_id)

  // A fresh empty tab opens with the address focused.
  const wasActive = useRef(false)
  useEffect(() => {
    if (active && !wasActive.current && !hasPage) setEditing(true)
    wasActive.current = active
  }, [active, hasPage])
  useEffect(() => {
    if (!editing) return
    const input = inputRef.current
    input?.focus()
    queueMicrotask(() => input?.select())
  }, [editing])

  const history = preview ? { back: backEnabled(preview, session), forward: forwardEnabled(preview, session) } : { back: false, forward: false }
  const stop = () => {
    setEditing(false)
    setDraft("")
  }
  const startEditing = () => {
    onAddressError(null)
    setDraft(address?.full ?? "")
    setEditing(true)
  }
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const text = draft.trim()
    if (!text) { stop(); return }
    setBusy(true)
    const outcome = await openPreviewInput(threadId, text)
    setBusy(false)
    if (outcome.status === "error") {
      onAddressError(outcome.message || null)
      inputRef.current?.focus()
      return
    }
    onAddressError(null)
    stop()
    inputRef.current?.blur()
  }
  const openInBrowser = () => {
    if (!target) return
    void openExternal(target.kind === "file" ? `file://${address?.full ?? target.path}` : target.url)
  }
  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(address?.full ?? "")
      toast("Address copied")
    } catch {
      toast.error("Unable to copy the address", { description: "Select the address and copy it instead." })
    }
  }
  const showInExplorer = () => {
    if (target?.kind !== "file" || !projectId || !target.inProject) return
    const relative = target.path.slice(target.root.length + 1)
    useStore.getState().set((s) => ({ explorerFile: { ...s.explorerFile, [projectId]: relative }, rightOpen: true, rightTab: "explorer" }))
  }
  const toggleDevice = (on: boolean) => {
    if (!preview) return
    useStore.getState().setPreviewViewport(threadId, on ? startingDeviceViewport(environment.name) : { mode: "fill" })
  }
  const toggleFloat = (on: boolean) => useStore.getState().setPreviewFloating(threadId, on)
  const fileOnRemote = target?.kind === "file" && environment.remote
  const floatBlocked = target?.kind === "external"
  const deviceLabel = device ? "Hide device toolbar" : "Show device toolbar"
  const floatLabel = floating ? "Return to panel" : "Float over chat"

  const GlyphIcon = session.load.phase === "blocked" ? ShieldIcon
    : session.load.phase === "waiting" || session.load.phase === "error" ? TriangleAlertIcon
    : target?.kind === "file" ? FileIcon
    : GlobeIcon

  return (
    <form
      onSubmit={submit}
      data-preview-chrome
      className="chat-surface-divider relative flex h-9 shrink-0 items-center gap-1 pr-1.5 pl-2 font-system-ui"
    >
      <div role="group" aria-label="Navigation" className="flex items-center gap-0.5">
        <PreviewAction label="Back" aria-disabled={!history.back} className={cn(!history.back && "opacity-35 hover:!bg-transparent")} onClick={() => history.back && goPreview(threadId, -1)}>
          <ArrowLeftIcon />
        </PreviewAction>
        {!narrow && (
          <PreviewAction label="Forward" aria-disabled={!history.forward} className={cn(!history.forward && "opacity-35 hover:!bg-transparent")} onClick={() => history.forward && goPreview(threadId, 1)}>
            <ArrowRightIcon />
          </PreviewAction>
        )}
        <PreviewAction
          label={loading ? "Stop loading" : "Reload"}
          aria-disabled={!hasPage}
          className={cn(!hasPage && "opacity-35 hover:!bg-transparent")}
          onClick={() => {
            if (!hasPage) return
            if (loading) stopPreviewLoading(threadId)
            else reloadPreview(threadId)
          }}
        >
          <IconSwap className="size-3.5" active={loading ? "b" : "a"} a={<RefreshCwIcon />} b={<XIcon />} />
        </PreviewAction>
      </div>

      <div
        data-preview-address
        className={cn(
          "group/address flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 transition-[background-color,box-shadow] duration-150 ease-[var(--ease-out)]",
          editing
            ? "bg-[var(--color-background-elevated-secondary)] ring-1 ring-inset ring-[var(--ring)]/45"
            : "hover:bg-[var(--color-background-button-secondary)]",
        )}
      >
        <GlyphIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/70" />
        {!editing && target?.kind === "server" && environment.remote && (
          <Tooltip>
            <TooltipTrigger render={<span className="shrink-0 rounded-[5px] bg-[var(--color-background-button-secondary)] px-1 text-[10px] leading-4 font-medium text-muted-foreground" />}>{environment.name}</TooltipTrigger>
            <TooltipPopup side="bottom">Served from {environment.name} through Kybern</TooltipPopup>
          </Tooltip>
        )}
        {editing ? (
          <input
            ref={inputRef}
            aria-label="Address"
            value={draft}
            disabled={busy}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            enterKeyHint="go"
            placeholder="Enter a URL or file path"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => { if (!busy) { stop(); onAddressError(null) } }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                stop()
                onAddressError(null)
                inputRef.current?.blur()
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-[length:var(--app-font-size-ui,12px)] text-foreground outline-none placeholder:text-muted-foreground/60"
          />
        ) : (
          <button
            type="button"
            aria-label="Address"
            onClick={startEditing}
            title={session.navigatedAway ? "The page has navigated since" : address?.full}
            className={cn(
              "min-w-0 flex-1 truncate text-left text-[length:var(--app-font-size-ui,12px)] outline-none focus-visible:ring-1 focus-visible:ring-ring",
              session.navigatedAway && "text-muted-foreground/70",
            )}
          >
            {address ? address.segments.map((segment, index) => (
              <span key={index} className={segment.emphasis && !session.navigatedAway ? "text-foreground/90" : "text-muted-foreground/70"}>{segment.text}</span>
            )) : <span className="text-muted-foreground/60">Enter a URL or file path</span>}
          </button>
        )}
        {hasPage && !editing && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Open in browser"
                  aria-disabled={fileOnRemote}
                  onClick={() => !fileOnRemote && openInBrowser()}
                  className={cn(
                    "press flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[opacity,background-color] duration-150 ease-[var(--ease-out)] outline-none hover:bg-[var(--color-background-elevated-secondary)] hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring group-hover/address:opacity-100 pointer-coarse:opacity-100",
                    fileOnRemote && "cursor-default opacity-0 group-hover/address:opacity-40 hover:!bg-transparent",
                  )}
                />
              }
            >
              <ExternalLinkIcon className="size-[13px]" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">{fileOnRemote ? `This file is on ${environment.name}` : "Open in browser"}</TooltipPopup>
          </Tooltip>
        )}
      </div>

      {hasPage && (
        <PreviewActionGroup>
          {!narrow && <span className="flex items-center gap-0.5">
            <PreviewToggle label={deviceLabel} pressed={device} onPressedChange={toggleDevice}>
              <DeviceMobileIcon className="size-3.5" />
            </PreviewToggle>
            <PreviewToggle label={floatBlocked ? "Floating preview is available for local pages" : floatLabel} pressed={floating} onPressedChange={(on) => !floatBlocked && toggleFloat(on)}>
              <PictureInPictureIcon className="size-3.5" />
            </PreviewToggle>
          </span>}
          <Menu>
            <MenuTrigger render={<IconButton variant="chrome" size="icon-xs" label="More" tooltip="More" tooltipSide="bottom" className="!min-w-7 !px-0" />}>
              <EllipsisIcon className="size-3.5" />
            </MenuTrigger>
            <ComposerPickerMenuPopup align="end" side="bottom" className="w-56">
              <MenuGroup>
                {narrow && (
                  <>
                    <MenuItem onClick={() => toggleDevice(!device)}>
                      <DeviceMobileIcon className="size-3.5 shrink-0" />
                      <span>{deviceLabel}</span>
                    </MenuItem>
                    <MenuItem disabled={floatBlocked} onClick={() => toggleFloat(!floating)}>
                      <PictureInPictureIcon className="size-3.5 shrink-0" />
                      <span>{floatLabel}</span>
                    </MenuItem>
                  </>
                )}
                <MenuItem onClick={() => reloadPreview(threadId, { fresh: true })}>
                  <RefreshCwIcon className="size-3.5 shrink-0" />
                  <span>Reload without cache</span>
                </MenuItem>
                <MenuItem onClick={() => void copyAddress()}>
                  <CopyIcon className="size-3.5 shrink-0" />
                  <span>Copy address</span>
                </MenuItem>
                <MenuItem disabled={fileOnRemote} onClick={openInBrowser}>
                  <ExternalLinkIcon className="size-3.5 shrink-0" />
                  <span>Open in browser</span>
                </MenuItem>
                {target?.kind === "file" && target.inProject && (
                  <MenuItem onClick={showInExplorer}>
                    <FolderIcon className="size-3.5 shrink-0" />
                    <span>Show file in Explorer</span>
                  </MenuItem>
                )}
              </MenuGroup>
              <MenuSeparator />
              <MenuGroup>
                {localServer && (
                  <MenuCheckboxItem checked={relay} onCheckedChange={(checked) => useStore.getState().setPreviewRelay(threadId, checked)}>
                    <span>Preview through Kybern</span>
                  </MenuCheckboxItem>
                )}
                <MenuItem onClick={() => closePreviewPageAndRelease(threadId)}>
                  <XIcon className="size-3.5 shrink-0" />
                  <span>Close page</span>
                </MenuItem>
              </MenuGroup>
            </ComposerPickerMenuPopup>
          </Menu>
        </PreviewActionGroup>
      )}

      <span
        aria-hidden
        data-loading={loading}
        data-testid="preview-loading"
        className="preview-loading pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-0.5 origin-left"
      />
    </form>
  )
}

function backEnabled(preview: WebPreview, session: PreviewSession): boolean {
  const entry = preview.entries[preview.index]
  return (entry?.target.kind === "file" && session.bridge.back > 0) || preview.index > 0
}
function forwardEnabled(preview: WebPreview, session: PreviewSession): boolean {
  const entry = preview.entries[preview.index]
  return (entry?.target.kind === "file" && session.bridge.forward > 0) || preview.index < preview.entries.length - 1
}
