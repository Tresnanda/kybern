import { AnimatePresence, usePresence } from "motion/react"
import { useEffect, useMemo, useRef, type MouseEvent } from "react"

import { Logo, Spinner } from "@/components/kybern/bits"
import { Markdown } from "@/components/kybern/Markdown"
import { Button } from "@/components/kit/button"
import { APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME } from "@/components/kit/chat/composerPickerStyles"
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/kit/dialog"
import { IconButton } from "@/components/kit/icon-button"
import { SidebarMenuButton, SidebarMenuItem } from "@/components/kit/sidebar"
import { Toaster } from "@/components/ui/sonner"
import {
  canSelfUpdate,
  closeUpdateDetails,
  dismissUpdateAnnouncement,
  installAppUpdate,
  openUpdateDetails,
  useAppUpdate,
} from "@/lib/appUpdate"
import {
  ArrowRightIcon,
  ArrowUpCircleIcon,
  ArrowUpRightIcon,
  InfoIcon,
  XIcon,
} from "@/lib/kit/icons"
import { SIDEBAR_ROW_HOVER_CLASS_NAME } from "@/lib/kit/sidebarRowStyles"
import { releasePresentation } from "@/lib/releaseNotes"
import { openExternal } from "@/lib/tauri"
import { cn } from "@/lib/utils"

let detailsTrigger: HTMLElement | null = null

function showDetails(event: MouseEvent<HTMLButtonElement>) {
  detailsTrigger = event.currentTarget
  openUpdateDetails()
}

function detailsFocusTarget() {
  const visible = (element: HTMLElement | null) => {
    if (!element?.isConnected || !element.getClientRects().length) return false
    const rect = element.getBoundingClientRect()
    return (
      rect.right > 0 &&
      rect.left < innerWidth &&
      rect.bottom > 0 &&
      rect.top < innerHeight
    )
  }
  if (visible(detailsTrigger)) return detailsTrigger
  const sidebar = document.querySelector<HTMLElement>(
    '[data-update-details-trigger="sidebar"]'
  )
  if (visible(sidebar)) return sidebar
  return document.querySelector<HTMLElement>('[data-testid="composer-editor"]')
}

function ReleaseArtwork({ compact = false }: { compact?: boolean }) {
  return (
    <div
      data-release-artwork
      className={cn(
        "relative isolate mx-3 mt-3 flex shrink-0 items-center justify-center overflow-hidden rounded-2xl",
        compact ? "h-36" : "h-[clamp(5rem,20vh,11rem)]"
      )}
      aria-hidden
    >
      <img
        src="/release-background.png"
        alt=""
        draggable={false}
        className="absolute inset-0 -z-10 size-full object-cover object-center"
      />
      <Logo size={compact ? 76 : 96} className="text-white" />
    </div>
  )
}

/** Infrequent update notices use the existing toast transition and never take focus. */
function UpdateAnnouncement({
  version,
  notes,
}: {
  version: string
  notes: string | null
}) {
  const release = useMemo(
    () => releasePresentation(version, notes),
    [version, notes]
  )
  const [present, safeToRemove] = usePresence()
  const element = useRef<HTMLElement>(null)
  const remove = useRef(safeToRemove)
  useEffect(() => {
    remove.current = safeToRemove
  }, [safeToRemove])
  useEffect(() => {
    const node = element.current
    if (!node) return
    let timer: ReturnType<typeof setTimeout> | undefined
    if (present) {
      node.getBoundingClientRect()
      node.classList.add("is-open")
    } else {
      node.classList.remove("is-open")
      const duration = getComputedStyle(node)
        .getPropertyValue("--toast-close")
        .trim()
      const ms = duration.endsWith("ms")
        ? parseFloat(duration)
        : parseFloat(duration) * 1000
      timer = setTimeout(
        () => remove.current?.(),
        matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : Number.isFinite(ms)
            ? ms
            : 250
      )
    }
    return () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [present])

  return (
    <aside
      ref={element}
      data-testid="update-announcement"
      aria-label="Kybern update available"
      aria-hidden={!present}
      inert={!present}
      className={cn(
        APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME,
        "t-toast release-announcement font-system-ui fixed right-4 bottom-4 z-40 flex max-h-[calc(100dvh-2rem)] w-[22rem] max-w-[calc(100vw-2rem)] flex-col overflow-y-auto rounded-3xl text-foreground"
      )}
    >
      <ReleaseArtwork compact />
      <IconButton
        label="Dismiss update announcement"
        size="icon-sm"
        className="absolute end-5 top-5 !size-8 !rounded-full !bg-black/35 !text-white hover:!bg-black/55"
        onClick={() => {
          dismissUpdateAnnouncement()
          detailsFocusTarget()?.focus({ preventScroll: true })
        }}
      >
        <XIcon className="size-4" />
      </IconButton>
      <div className="flex flex-col gap-2 p-5">
        <p className="text-xs font-medium text-muted-foreground" role="status">
          New · v{version.replace(/^v/, "")}
        </p>
        <h2 className="text-lg leading-snug font-medium text-balance break-words">
          {release.title}
        </h2>
        <p className="line-clamp-3 text-sm leading-relaxed text-pretty text-muted-foreground">
          {release.summary}
        </p>
        <Button
          variant="ghost"
          onClick={showDetails}
          className="-ms-2.5 mt-2 h-auto min-h-8 self-start text-start !font-medium whitespace-normal"
        >
          See what’s new <ArrowRightIcon className="size-4" />
        </Button>
      </div>
    </aside>
  )
}

function UpdateAction({ className }: { className?: string }) {
  const phase = useAppUpdate((state) => state.phase)
  const progress = useAppUpdate((state) => state.progress)
  const errorKind = useAppUpdate((state) => state.errorKind)
  const busy = phase === "installing" || phase === "checking"
  const label =
    phase === "installing"
      ? progress === null
        ? "Updating…"
        : `Updating… ${Math.round(progress * 100)}%`
      : errorKind === "install"
        ? "Retry update"
        : "Update and restart"
  return (
    <Button
      disabled={busy}
      onClick={() => void installAppUpdate()}
      className={cn("tabular-nums", className)}
    >
      {busy && <Spinner />}
      {label}
    </Button>
  )
}

/** A persistent, one-click update entry beside Settings. The note button reopens details. */
export function SidebarUpdateButton() {
  const version = useAppUpdate((state) => state.version)
  const phase = useAppUpdate((state) => state.phase)
  const progress = useAppUpdate((state) => state.progress)
  const errorKind = useAppUpdate((state) => state.errorKind)
  if (!version || !canSelfUpdate()) return null
  const busy = phase === "installing" || phase === "checking"
  const label =
    phase === "installing"
      ? progress === null
        ? "Updating…"
        : `Updating… ${Math.round(progress * 100)}%`
      : errorKind === "install"
        ? "Retry update"
        : "Update and restart"
  return (
    <SidebarMenuItem>
      <div
        data-testid="sidebar-update"
        className="flex min-w-0 items-center gap-1 rounded-xl bg-[var(--color-background-button-secondary)] p-1"
      >
        <SidebarMenuButton
          aria-label={label}
          disabled={busy}
          onClick={() => void installAppUpdate()}
          title="Installs the update and restarts Kybern and the agents running on this machine."
          className={cn(
            "!h-auto min-h-10 min-w-0 flex-1 gap-2 !px-2 !py-1.5",
            SIDEBAR_ROW_HOVER_CLASS_NAME
          )}
        >
          {busy ? (
            <Spinner size={16} />
          ) : (
            <ArrowUpCircleIcon className="size-4 shrink-0" />
          )}
          <span className="flex min-w-0 flex-col gap-0.5 text-start">
            <span className="text-[length:var(--app-font-size-ui,12px)] leading-snug font-medium tabular-nums">
              {label}
            </span>
            <span className="text-[length:var(--app-font-size-ui-sm,11px)] leading-snug text-muted-foreground">
              Kybern v{version.replace(/^v/, "")}
            </span>
          </span>
        </SidebarMenuButton>
        <IconButton
          data-update-details-trigger="sidebar"
          label="See what’s new"
          tooltip="See what’s new"
          size="icon-sm"
          className="!size-8 shrink-0 !rounded-lg"
          onClick={showDetails}
        >
          <InfoIcon className="size-4" />
        </IconButton>
      </div>
    </SidebarMenuItem>
  )
}

/** App-wide updates stay independent of the selected project or connected daemon. */
export function AppUpdateSurface() {
  const version = useAppUpdate((state) => state.version)
  const notes = useAppUpdate((state) => state.notes)
  const announcementOpen = useAppUpdate((state) => state.announcementOpen)
  const detailsOpen = useAppUpdate((state) => state.detailsOpen)
  const phase = useAppUpdate((state) => state.phase)
  const progress = useAppUpdate((state) => state.progress)
  const error = useAppUpdate((state) => state.error)
  const title = useRef<HTMLHeadingElement>(null)
  const release = useMemo(
    () => (version ? releasePresentation(version, notes) : null),
    [version, notes]
  )

  return (
    <>
      <AnimatePresence initial={false}>
        {version && announcementOpen && !detailsOpen && (
          <UpdateAnnouncement key={version} version={version} notes={notes} />
        )}
      </AnimatePresence>
      <Dialog
        open={!!version && detailsOpen}
        onOpenChange={(open) => {
          if (!open) closeUpdateDetails()
        }}
      >
        <DialogPopup
          data-testid="update-details"
          className="font-system-ui max-h-[calc(100dvh-2rem)] max-w-xl overflow-hidden !rounded-3xl"
          bottomStickOnMobile={false}
          showCloseButton={false}
          initialFocus={title}
          finalFocus={detailsFocusTarget}
        >
          <ReleaseArtwork />
          <DialogClose
            render={
              <IconButton
                label="Close release details"
                size="icon-sm"
                className="absolute end-5 top-5 !size-8 !rounded-full !bg-black/35 !text-white hover:!bg-black/55"
              />
            }
          >
            <XIcon className="size-4" />
          </DialogClose>
          <div className="flex shrink-0 flex-col gap-2 px-6 pt-5 pb-3">
            <DialogDescription className="text-xs font-medium">
              New · v{version?.replace(/^v/, "")}
            </DialogDescription>
            <DialogTitle
              ref={title}
              tabIndex={-1}
              className="!font-system-ui text-xl leading-snug font-medium text-balance break-words outline-none"
            >
              {release?.title}
            </DialogTitle>
          </div>
          <DialogPanel className="!px-6 !pt-0 !pb-4">
            {release?.notes ? (
              <Markdown
                text={release.notes}
                className="release-notes text-sm leading-relaxed [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm"
              />
            ) : (
              <p className="text-sm leading-relaxed text-pretty text-muted-foreground">
                {release?.summary}
              </p>
            )}
            {release && (
              <Button
                variant="link"
                className="-ms-3 mt-3 h-auto min-h-8 text-start whitespace-normal"
                onClick={() => void openExternal(release.url)}
              >
                Read release notes <ArrowUpRightIcon className="size-3.5" />
              </Button>
            )}
          </DialogPanel>
          <div className="shrink-0 px-6 pt-2">
            {phase === "installing" ? (
              <div className="flex flex-col gap-2" role="status">
                <p className="text-xs text-muted-foreground">
                  {progress === 1
                    ? "Finishing installation…"
                    : "Downloading the update…"}
                </p>
                {progress !== null && (
                  <progress
                    className="h-1 w-full accent-current"
                    value={progress}
                    max={1}
                    aria-label="Update download progress"
                  />
                )}
              </div>
            ) : (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Installing restarts Kybern and the agents running on this
                machine.
              </p>
            )}
            {error && (
              <p
                role="alert"
                className="mt-2 text-xs leading-relaxed break-words text-destructive"
              >
                {error}
              </p>
            )}
          </div>
          <DialogFooter className="!px-6 !pt-4 !pb-5">
            <DialogClose render={<Button variant="ghost" />}>Later</DialogClose>
            <UpdateAction className="!h-auto !min-h-9 !rounded-xl !px-4 !py-2" />
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Toaster position={announcementOpen ? "top-right" : "bottom-right"} />
    </>
  )
}
